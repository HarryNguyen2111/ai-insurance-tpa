import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IdentityTenantModule } from '../identity-tenant/identity.module.ts';
import { OidcVerifier } from '../identity-tenant/oidc-verifier.ts';
import { syntheticIssuer } from '../../test/fixtures/synthetic-issuer.ts';
import { ClaimsModule } from './claims.module.ts';
import { domain, stale } from './claim-error.ts';

describe('CLM-02 HTTP contract', () => {
  let app: INestApplication, unconfigured: INestApplication, issuer: Awaited<ReturnType<typeof syntheticIssuer>>, token: string;
  const api = { submit: jest.fn(), list: jest.fn(), get: jest.fn(), supplement: jest.fn() };
  const id = '12345678-1234-1234-1234-123456789abc';
  const headers = () => ({ Authorization: `Bearer ${token}`, 'X-Membership-Context': 'synthetic-context', 'Idempotency-Key': 'synthetic-claim-key-0001' });
  beforeAll(async () => {
    issuer = await syntheticIssuer(); token = await issuer.token('SYNTHETIC_PII_MARKER');
    const identity = IdentityTenantModule.register({ verifier: new OidcVerifier(issuer.profile) });
    app = (await Test.createTestingModule({ imports: [identity, ClaimsModule.register({ identity, api })] }).compile()).createNestApplication({ logger: false });
    await app.init();
    const bare = IdentityTenantModule.register({ verifier: new OidcVerifier(issuer.profile) });
    unconfigured = (await Test.createTestingModule({ imports: [bare, ClaimsModule.register({ identity: bare })] }).compile()).createNestApplication({ logger: false });
    await unconfigured.init();
  });
  afterAll(async () => { await app.close(); await unconfigured.close(); await issuer.close(); });
  beforeEach(() => jest.resetAllMocks());

  it('requires bearer, membership context and Idempotency-Key on submit/supplement; rejects tenant assertions', async () => {
    const s = app.getHttpServer();
    await request(s).post('/v1/claims').send({}).expect(401);
    await request(s).get('/v1/claims').expect(401);
    await request(s).post('/v1/claims').set({ ...headers(), 'X-Tenant-Id': id }).send({}).expect(403);
    await request(s).post('/v1/claims').set({ Authorization: `Bearer ${token}`, 'X-Membership-Context': 'ctx' }).send({}).expect(422);
    await request(s).post('/v1/claims').set({ ...headers(), 'Idempotency-Key': 'short' }).send({}).expect(422);
    await request(s).post(`/v1/claims/${id}/documents`).set({ Authorization: `Bearer ${token}`, 'X-Membership-Context': 'ctx' }).send({}).expect(422);
    await request(s).get('/v1/claims').set({ Authorization: `Bearer ${token}` }).expect(422);
    expect(api.submit).not.toHaveBeenCalled(); expect(api.supplement).not.toHaveBeenCalled(); expect(api.list).not.toHaveBeenCalled();
  });
  it('returns 201 + Location + no-store and marks replays; passes no tenant to the domain port', async () => {
    api.submit.mockResolvedValue({ status: 201, body: { claimId: id, totalRequested: '1500000.00' }, replayed: true });
    const r = await request(app.getHttpServer()).post('/v1/claims').set(headers()).send({ memberId: id }).expect(201);
    expect(r.headers).toMatchObject({ 'cache-control': 'no-store', location: `/v1/claims/${id}`, 'idempotent-replayed': 'true' });
    expect(r.body.totalRequested).toBe('1500000.00');
    expect(api.submit.mock.calls[0][0]).toMatchObject({ membershipContext: 'synthetic-context', idempotencyKey: 'synthetic-claim-key-0001' });
    expect(api.submit.mock.calls[0][0]).not.toHaveProperty('tenantId');
  });
  it('forwards raw list query for allowlisting and maps domain errors without echoing input', async () => {
    api.list.mockResolvedValue({ items: [] });
    await request(app.getHttpServer()).get('/v1/claims?status=SUBMITTED&limit=5').set(headers()).expect(200).expect('cache-control', 'no-store');
    expect(api.list.mock.calls[0][1]).toEqual({ status: 'SUBMITTED', limit: '5' });
    api.supplement.mockRejectedValue(stale());
    const conflict = await request(app.getHttpServer()).post(`/v1/claims/${id}/documents`).set(headers()).send({ expectedVersion: 1, documentIds: [id] }).expect(409);
    expect(conflict.body).toMatchObject({ code: 'STALE_VERSION' }); expect(conflict.headers['retry-after']).toBeUndefined();
    api.get.mockRejectedValue(domain('STATUS_NOT_ALLOWED'));
    await request(app.getHttpServer()).get(`/v1/claims/${id}`).set(headers()).expect(422);
    api.get.mockRejectedValue(new Error('SYNTHETIC_PII_MARKER 0912345678 secret'));
    const r = await request(app.getHttpServer()).get(`/v1/claims/${id}`).set(headers()).expect(503);
    expect(JSON.stringify(r.body)).not.toMatch(/SYNTHETIC|0912345678|secret/);
    expect(Object.keys(r.body).sort()).toEqual(['code', 'correlationId', 'messageVi']);
  });
  it('fails closed with 503 when purposes/preflight gate are not provisioned', async () => {
    const r = await request(unconfigured.getHttpServer()).get('/v1/claims').set(headers()).expect(503);
    expect(r.body.code).toBe('PROVIDER_NOT_CONFIGURED');
  });
});
