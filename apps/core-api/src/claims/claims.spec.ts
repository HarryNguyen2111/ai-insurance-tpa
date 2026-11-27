import { CLAIM_STATUSES, CLAIM_TRANSITIONS, GATED_TARGETS, transitionAllowed } from './claim-state.ts';
import { decodeCursor, encodeCursor, parseListQuery } from './claim-query.ts';
import { transitionClaim } from './claims.store.ts';
import type { WorkflowRuntime } from '../workflow-definition/workflow-runtime.ts';

const M1 = '11111111-1111-4111-8111-111111111111', M2 = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const reject = (fn: () => unknown, code = 'VALIDATION_FAILED') => expect(fn).toThrow(expect.objectContaining({ status: 422, code }));

describe('CLM-02 claim state machine (spec 03 §1)', () => {
  it('covers every status, only targets known statuses and keeps terminal states terminal', () => {
    expect(Object.keys(CLAIM_TRANSITIONS).sort()).toEqual([...CLAIM_STATUSES].sort());
    for (const targets of Object.values(CLAIM_TRANSITIONS)) for (const t of targets) expect(CLAIM_STATUSES).toContain(t);
    for (const terminal of ['PAID', 'REJECTED', 'CLOSED_EXPIRED'] as const) expect(CLAIM_TRANSITIONS[terminal]).toEqual([]);
    expect(transitionAllowed('SUBMITTED', 'PAID')).toBe(false);
    expect(transitionAllowed('AI_PROCESSING', 'SUPPLEMENT_REQUIRED')).toBe(true);
    expect(transitionAllowed('SUPPLEMENT_REQUIRED', 'SUBMITTED')).toBe(true);
    // PAID only after payout processing; EOB/OTP/payout evidence targets are gated elsewhere.
    expect(Object.entries(CLAIM_TRANSITIONS).filter(([, t]) => t.includes('PAID')).map(([f]) => f)).toEqual(['PAYOUT_PROCESSING']);
    expect([...GATED_TARGETS].sort()).toEqual(['EOB_READY', 'OTP_SIGNED', 'PAID', 'PAYOUT_PROCESSING', 'SUBMITTED']);
  });
  it('refuses gated targets and malformed commands before touching the database', async () => {
    const tx = { query: jest.fn() }, runtime = {} as WorkflowRuntime;
    const base = { claimId: C, expectedVersion: 1, commandId: M1, actorType: 'SERVICE' as const, actorId: M2 };
    for (const toStatus of ['EOB_READY', 'OTP_SIGNED', 'PAYOUT_PROCESSING', 'PAID', 'SUBMITTED'] as const)
      await expect(transitionClaim(tx, runtime, { ...base, toStatus })).rejects.toMatchObject({ status: 422, code: 'DOMAIN_VIOLATION' });
    await expect(transitionClaim(tx, runtime, { ...base, toStatus: 'SUPPLEMENT_REQUIRED' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(transitionClaim(tx, runtime, { ...base, toStatus: 'DOCTOR_REVIEW', supplementDeadline: '2030-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(transitionClaim(tx, runtime, { ...base, expectedVersion: 0, toStatus: 'DOCTOR_REVIEW' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(transitionClaim(tx, runtime, { ...base, toStatus: 'UNKNOWN' as never })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(tx.query).not.toHaveBeenCalled();
  });
});

describe('CLM-02 list query allowlist and cursor binding', () => {
  it('accepts only cursor/limit/status/memberId with strict values', () => {
    expect(parseListQuery({})).toEqual({ limit: 20 });
    expect(parseListQuery({ limit: '100', status: 'SUPPLEMENT_REQUIRED', memberId: M1 })).toEqual({ limit: 100, status: 'SUPPLEMENT_REQUIRED', memberId: M1 });
    for (const q of [{ tenantId: M1 }, { sort: 'amount' }, { q: '{"match_all":{}}' }, { limit: '0' }, { limit: '101' }, { limit: '1.5' },
      { limit: ['1', '2'] }, { status: 'DONE' }, { memberId: 'x' }, { status: { $ne: 'PAID' } }, { cursor: '' }]) reject(() => parseListQuery(q));
    reject(() => parseListQuery(null));
  });
  it('binds the opaque cursor to membership and filters, never the tenant', () => {
    const q = parseListQuery({ status: 'SUBMITTED' }), pos = { createdAt: '2026-11-27T01:02:03.123456Z', claimId: C };
    const cursor = encodeCursor(M1, q, pos);
    expect(Buffer.from(cursor, 'base64url').toString()).not.toContain(M1);
    expect(decodeCursor(M1, { ...q, cursor, limit: 5 })).toEqual(pos); // page size may change
    reject(() => decodeCursor(M2, { ...q, cursor }), 'VALIDATION_FAILED');
    reject(() => decodeCursor(M1, { limit: 20, cursor }));
    reject(() => decodeCursor(M1, { ...q, memberId: M2, cursor }));
    const forged = Buffer.from(JSON.stringify([1, 'f'.repeat(64), pos.createdAt, C])).toString('base64url');
    reject(() => decodeCursor(M1, { ...q, cursor: forged }));
    reject(() => decodeCursor(M1, { ...q, cursor: 'not base64!' }));
    expect(decodeCursor(M1, q)).toBeUndefined();
  });
});
