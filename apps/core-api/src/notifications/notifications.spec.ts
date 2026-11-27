import { decodeCursor, encodeCursor, parseCountQuery, parseListQuery } from './notifications.store.ts';

describe('NOTIF-01 query allowlist and cursor binding', () => {
  const P = '00000000-0000-4000-8000-0000000000a1', M = '00000000-0000-4000-8000-0000000000b1', N = '00000000-0000-4000-8000-0000000000c1';
  const at = '2026-11-27T03:00:00.123456Z';
  it('requires an explicit scope and allowlists filters; repeated, unknown or tenant keys are rejected', () => {
    expect(parseListQuery({ scope: 'TENANT' })).toEqual({ scope: 'TENANT', status: 'ALL', limit: 20 });
    expect(parseListQuery({ scope: 'PERSONAL', service: 'LOYALTY360', status: 'UNREAD', limit: '50' }))
      .toEqual({ scope: 'PERSONAL', service: 'LOYALTY360', status: 'UNREAD', limit: 50 });
    for (const bad of [{}, { scope: 'ALL' }, { scope: 'TENANT', tenantId: M }, { scope: ['TENANT', 'PERSONAL'] }, { scope: 'TENANT', limit: '51' },
      { scope: 'TENANT', limit: '0' }, { scope: 'TENANT', limit: '1.5' }, { scope: 'TENANT', status: 'READ' }, { scope: 'TENANT', service: 'BANK' },
      { scope: 'TENANT', sort: 'createdAt' }, { scope: 'TENANT', cursor: '' }, null, []]) {
      expect(() => parseListQuery(bad)).toThrow(expect.objectContaining({ status: 422, code: 'VALIDATION_FAILED' }));
    }
    expect(parseCountQuery({ scope: 'TENANT', service: 'TPA_INSURANCE' })).toEqual({ scope: 'TENANT', service: 'TPA_INSURANCE' });
    expect(() => parseCountQuery({ scope: 'TENANT', status: 'UNREAD' })).toThrow(expect.objectContaining({ status: 422 }));
  });
  it('cursor is bound to principal, scope, membership and filters (not page size) and carries no tenant', () => {
    const q = parseListQuery({ scope: 'TENANT', status: 'UNREAD' });
    const cursor = encodeCursor(P, M, q, at, N);
    expect(Buffer.from(cursor, 'base64url').toString()).not.toMatch(/TENANT|tenant/);
    expect(decodeCursor(P, M, { ...q, limit: 5, cursor })).toEqual({ createdAt: at, id: N });
    const reject = (principal: string, membership: string | null, query: object) =>
      expect(() => decodeCursor(principal, membership, { ...q, ...query, cursor } as never)).toThrow(expect.objectContaining({ status: 422 }));
    reject(N, M, {}); reject(P, N, {}); reject(P, null, {}); reject(P, M, { status: 'ALL' }); reject(P, M, { service: 'TPA_INSURANCE' }); reject(P, M, { scope: 'PERSONAL' });
    expect(() => decodeCursor(P, M, { ...q, cursor: 'not base64!' })).toThrow(expect.objectContaining({ status: 422 }));
  });
});
