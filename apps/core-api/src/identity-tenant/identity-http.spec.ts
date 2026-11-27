import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { IdentityTenantModule } from './identity.module.ts';
import { OidcVerifier } from './oidc-verifier.ts';
import type { IdentityStore } from './identity-store.ts';
import { syntheticIssuer } from '../../test/fixtures/synthetic-issuer.ts';

describe('identity HTTP contract and trust boundary', () => {
  let issuer: Awaited<ReturnType<typeof syntheticIssuer>>, app: INestApplication, token: string;
  const principalId = randomUUID(), membershipId = randomUUID();
  const store = { me: jest.fn(), select: jest.fn(), close: jest.fn() };
  beforeAll(async () => {
    issuer = await syntheticIssuer(); token = await issuer.token('synthetic-pii-marker', { tenantId: randomUUID(), roles: ['FINANCE'] });
    const module = await Test.createTestingModule({ imports: [IdentityTenantModule.register({ verifier: new OidcVerifier(issuer.profile), store: store as unknown as IdentityStore })] }).compile();
    app = module.createNestApplication({ logger: false }); await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks(); store.me.mockResolvedValue({ principalId, memberships: [{ membershipId, roles: ['MEMBER'], memberIds: [], version: 1 }], mfaVerified: true });
    store.select.mockResolvedValue({ view: { membershipId, contextToken: 'synthetic-opaque-context', expiresAt: new Date(Date.now() + 60000).toISOString() }, replayed: false });
  });
  afterAll(async () => { await app.close(); await issuer.close(); });
  it('returns server grant fields only, not token tenant/role/PII claims', async () => {
    const response = await request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store'); expect(response.body.principalId).toBe(principalId);
    expect(response.body.memberships[0].roles).toEqual(['MEMBER']);
    expect(JSON.stringify(response.body)).not.toMatch(/FINANCE|tenantId|synthetic-pii/);
    expect(store.me.mock.calls[0][0]).not.toHaveProperty('tenantId');
  });
  it('requires valid authentication and rejects a client tenant header before store access', async () => {
    const missing = await request(app.getHttpServer()).get('/v1/me').expect(401);
    expect(missing.body.code).toBe('UNAUTHENTICATED'); expect(missing.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(missing.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', randomUUID()).expect(403);
    await request(app.getHttpServer()).get('/v1/me').set({ Authorization: [`Bearer ${token}`, `Bearer ${token}`] }).expect(401);
    expect(store.me).not.toHaveBeenCalled();
  });
  it('selects membership with valid idempotency and rejects unknown/body tenant fields', async () => {
    for (const body of [{ membershipId, tenantId: randomUUID() }, { membershipId, roles: ['FINANCE'] }, {}, { membershipId: 'forged' }]) {
      const response = await request(app.getHttpServer()).post('/v1/me/membership').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body).expect(422);
      expect(JSON.stringify(response.body)).not.toContain(token);
    }
    await request(app.getHttpServer()).post('/v1/me/membership').set('Authorization', `Bearer ${token}`).send({ membershipId }).expect(422);
    expect(store.select).not.toHaveBeenCalled();
    const response = await request(app.getHttpServer()).post('/v1/me/membership').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send({ membershipId }).expect(200);
    expect(response.body).toHaveProperty('contextToken'); expect(response.body).not.toHaveProperty('tenantId'); expect(response.headers['cache-control']).toBe('no-store');
  });
  it('sanitizes unexpected dependency failures without token/PII echoes', async () => {
    store.me.mockRejectedValueOnce(new Error(`synthetic-pii-marker ${token}`));
    const response = await request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${token}`).expect(503);
    expect(response.body.code).toBe('DEPENDENCY_UNAVAILABLE'); expect(JSON.stringify(response.body)).not.toMatch(/synthetic-pii|Bearer/);
  });
  it('leaves Zalo provider exchange unavailable without inventing provider semantics', async () => {
    const response = await request(app.getHttpServer()).post('/v1/auth/zalo/exchange').send({ authorizationCode: 'synthetic-pii-marker' }).expect(503);
    expect(response.body.code).toBe('PROVIDER_NOT_CONFIGURED'); expect(JSON.stringify(response.body)).not.toContain('synthetic-pii');
  });
});
