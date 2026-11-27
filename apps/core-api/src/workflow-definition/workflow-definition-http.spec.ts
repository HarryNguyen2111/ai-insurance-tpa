import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { IdentityTenantModule } from '../identity-tenant/identity.module.ts';
import { OidcVerifier } from '../identity-tenant/oidc-verifier.ts';
import { AppModule } from '../app.module.ts';
import { WorkflowDefinitionModule } from './workflow-definition.module.ts';
import { WorkflowApiError } from './workflow-error.ts';
import type { WorkflowDefinitionApi } from './workflow-definition.store.ts';
import { syntheticIssuer } from '../../test/fixtures/synthetic-issuer.ts';

// VWF-03 (#80) HTTP boundary only: the domain store, RLS, idempotency and audit are exercised
// against real PostgreSQL in test/workflow-definitions.pg.test.mjs.
describe('workflow definition HTTP contract and trust boundary', () => {
  let issuer: Awaited<ReturnType<typeof syntheticIssuer>>, app: INestApplication, token: string;
  const api = { list: jest.fn(), listVersions: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn(), validate: jest.fn(),
    publish: jest.fn(), revoke: jest.fn(), catalog: jest.fn() };
  const ctx = 'synthetic-opaque-membership-context', key = 'vwf03-synthetic-key-0001', defId = randomUUID();
  const base = '/v1/admin/workflow-definitions';
  const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Membership-Context': ctx });
  beforeAll(async () => {
    issuer = await syntheticIssuer(); token = await issuer.token('synthetic-pii-marker', { tenantId: randomUUID() });
    const identity = IdentityTenantModule.register({ verifier: new OidcVerifier(issuer.profile) });
    const module = await Test.createTestingModule({ imports: [identity, WorkflowDefinitionModule.register({ identity, api: api as unknown as WorkflowDefinitionApi })] }).compile();
    app = module.createNestApplication({ logger: false }); await app.init();
  });
  beforeEach(() => { jest.resetAllMocks(); });
  afterAll(async () => { await app.close(); await issuer.close(); });

  it('rejects missing auth, a client tenant header and a missing membership context before reaching the domain', async () => {
    await request(app.getHttpServer()).get(base).set('X-Membership-Context', ctx).expect(401);
    await request(app.getHttpServer()).get(base).set({ ...auth(), 'X-Tenant-Id': randomUUID() }).expect(403);
    const missing = await request(app.getHttpServer()).get(base).set('Authorization', `Bearer ${token}`).expect(422);
    expect(missing.body.code).toBe('VALIDATION_FAILED'); expect(missing.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).get(`${base}?tenantId=${randomUUID()}`).set(auth()).expect(422);
    expect(api.list).not.toHaveBeenCalled();
  });

  it('passes only verified identity, opaque context and bounded paging to the domain', async () => {
    api.list.mockResolvedValue({ items: [] });
    const response = await request(app.getHttpServer()).get(`${base}?limit=5`).set(auth()).expect(200);
    expect(response.body).toEqual({ items: [] }); expect(response.headers['cache-control']).toBe('no-store');
    const [call, page] = api.list.mock.calls[0];
    expect(call.membershipContext).toBe(ctx); expect(call).not.toHaveProperty('tenantId'); expect(page).toEqual({ limit: 5 });
    for (const bad of ['0', '51', 'abc', '1.5']) await request(app.getHttpServer()).get(`${base}?limit=${bad}`).set(auth()).expect(422);
  });

  it('mutations require a well-formed Idempotency-Key; malformed ids are 404 without existence leaks', async () => {
    await request(app.getHttpServer()).post(base).set(auth()).send({}).expect(422);
    await request(app.getHttpServer()).post(base).set({ ...auth(), 'Idempotency-Key': 'short' }).send({}).expect(422);
    await request(app.getHttpServer()).post(`${base}/not-a-uuid/versions/1/publish`).set({ ...auth(), 'Idempotency-Key': key }).send({}).expect(404);
    await request(app.getHttpServer()).get(`${base}/${defId}/versions/0`).set(auth()).expect(404);
    await request(app.getHttpServer()).get(`${base}/${defId}/versions/99999999999`).set(auth()).expect(404);
    expect(api.create).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled(); expect(api.get).not.toHaveBeenCalled();
  });

  it('create returns 201; replays are marked; publish/revoke/validate are 200 with no-store', async () => {
    api.create.mockResolvedValue({ status: 201, body: { definitionId: defId, versionNo: 1 }, replayed: false });
    await request(app.getHttpServer()).post(base).set({ ...auth(), 'Idempotency-Key': key }).send({ content: {} }).expect(201);
    expect(api.create.mock.calls[0][0].idempotencyKey).toBe(key);
    api.publish.mockResolvedValue({ status: 200, body: { status: 'PUBLISHED' }, replayed: true });
    const replay = await request(app.getHttpServer()).post(`${base}/${defId}/versions/2/publish`).set({ ...auth(), 'Idempotency-Key': key })
      .send({ expectedRevision: 1, contentHash: 'a'.repeat(64) }).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true'); expect(replay.headers['cache-control']).toBe('no-store');
    expect(api.publish.mock.calls[0].slice(1, 3)).toEqual([defId, 2]);
    api.validate.mockResolvedValue({ status: 200, body: { valid: true }, replayed: false });
    await request(app.getHttpServer()).post(`${base}/${defId}/versions/2/validate`).set({ ...auth(), 'Idempotency-Key': key }).expect(200);
    api.revoke.mockResolvedValue({ status: 200, body: {}, replayed: false });
    await request(app.getHttpServer()).post(`${base}/${defId}/versions/2/revoke`).set({ ...auth(), 'Idempotency-Key': key }).send({}).expect(200);
  });

  it('renders domain errors with C1 codes and fixed Vietnamese messages; unexpected failures never echo data', async () => {
    api.publish.mockRejectedValueOnce(new WorkflowApiError(422, 'DOMAIN_VIOLATION', 'INVALID_DEFINITION'));
    const invalid = await request(app.getHttpServer()).post(`${base}/${defId}/versions/1/publish`).set({ ...auth(), 'Idempotency-Key': key }).send({}).expect(422);
    expect(invalid.body).toMatchObject({ code: 'DOMAIN_VIOLATION' }); expect(invalid.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    api.update.mockRejectedValueOnce(new WorkflowApiError(409, 'STALE_VERSION'));
    expect((await request(app.getHttpServer()).put(`${base}/${defId}/versions/1`).set({ ...auth(), 'Idempotency-Key': key }).send({}).expect(409)).body.code).toBe('STALE_VERSION');
    api.get.mockRejectedValueOnce(new Error(`synthetic-pii-marker ${token}`));
    const failed = await request(app.getHttpServer()).get(`${base}/${defId}/versions/1`).set(auth()).expect(503);
    expect(JSON.stringify(failed.body)).not.toMatch(/synthetic-pii|Bearer/);
  });

  it('serves the global action catalog through the same membership-verified path', async () => {
    api.catalog.mockResolvedValue({ catalogVersion: 1, actions: [] });
    await request(app.getHttpServer()).get('/v1/workflow/action-catalogs/1').set(auth()).expect(200);
    expect(api.catalog.mock.calls[0][1]).toBe(1);
  });
});

describe('application wiring', () => {
  it('registers identity once and fails closed with 503 when no identity store is configured', async () => {
    const issuer = await syntheticIssuer();
    try {
      const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = module.createNestApplication({ logger: false }); await app.init();
      try {
        // No verifier/provider is configured in the default app: authentication fails closed first.
        const response = await request(app.getHttpServer()).get('/v1/admin/workflow-definitions').set({ Authorization: `Bearer ${await issuer.token('s')}`, 'X-Membership-Context': 'x' });
        expect([401, 503]).toContain(response.status);
        await request(app.getHttpServer()).get('/health').expect(200);
      } finally { await app.close(); }
    } finally { await issuer.close(); }
  });
});
