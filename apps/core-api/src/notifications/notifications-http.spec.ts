import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IdentityTenantModule } from '../identity-tenant/identity.module.ts';
import { OidcVerifier } from '../identity-tenant/oidc-verifier.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import { syntheticIssuer } from '../../test/fixtures/synthetic-issuer.ts';
import { NotificationsModule } from './notifications.module.ts';

describe('NOTIF-01 HTTP contract', () => {
  let app: INestApplication, unconfigured: INestApplication, issuer: Awaited<ReturnType<typeof syntheticIssuer>>, token: string;
  const api = { list: jest.fn(), unreadCount: jest.fn(), markRead: jest.fn(), markAllRead: jest.fn() };
  const id = '12345678-1234-1234-1234-123456789abc';
  const auth = () => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => {
    issuer = await syntheticIssuer(); token = await issuer.token('SYNTHETIC_PII_MARKER');
    const identity = IdentityTenantModule.register({ verifier: new OidcVerifier(issuer.profile) });
    app = (await Test.createTestingModule({ imports: [identity, NotificationsModule.register({ identity, api })] }).compile()).createNestApplication({ logger: false });
    await app.init();
    const bare = IdentityTenantModule.register({ verifier: new OidcVerifier(issuer.profile) });
    unconfigured = (await Test.createTestingModule({ imports: [bare, NotificationsModule.register({ identity: bare })] }).compile()).createNestApplication({ logger: false });
    await unconfigured.init();
  });
  afterAll(async () => { await app.close(); await unconfigured.close(); await issuer.close(); });
  beforeEach(() => jest.resetAllMocks());

  it('requires bearer and rejects tenant assertions before reaching the domain port', async () => {
    const s = app.getHttpServer();
    await request(s).get('/v1/me/notifications?scope=PERSONAL').expect(401);
    await request(s).get('/v1/me/notifications/unread-count?scope=PERSONAL').expect(401);
    await request(s).post(`/v1/me/notifications/${id}/read`).send({ scope: 'PERSONAL' }).expect(401);
    await request(s).post('/v1/me/notifications/read-all').send({ scope: 'PERSONAL', cutoff: '2026-11-27T03:00:00Z' }).expect(401);
    await request(s).get('/v1/me/notifications?scope=TENANT').set({ ...auth(), 'X-Tenant-Id': id }).expect(403);
    expect(api.list).not.toHaveBeenCalled(); expect(api.unreadCount).not.toHaveBeenCalled();
  });

  it('membership context header is optional but never ambiguous: absent, single, repeated (422) or oversized (422)', async () => {
    const s = app.getHttpServer();
    api.list.mockResolvedValue({ scope: 'PERSONAL', items: [], asOf: '2026-11-27T03:00:00.000000Z' });
    await request(s).get('/v1/me/notifications?scope=PERSONAL').set(auth()).expect(200).expect('cache-control', 'no-store');
    expect(api.list.mock.calls[0][0]).not.toHaveProperty('membershipContext');
    expect(api.list.mock.calls[0][1]).toEqual({ scope: 'PERSONAL' });
    await request(s).get('/v1/me/notifications?scope=TENANT&status=UNREAD').set({ ...auth(), 'X-Membership-Context': 'synthetic-context' }).expect(200);
    expect(api.list.mock.calls[1][0]).toMatchObject({ membershipContext: 'synthetic-context' });
    expect(api.list.mock.calls[1][0]).not.toHaveProperty('tenantId');
    await request(s).get('/v1/me/notifications?scope=TENANT').set(auth()).set('X-Membership-Context', ['a', 'b'] as unknown as string) // sent as two header lines.expect(422);
    await request(s).get('/v1/me/notifications?scope=TENANT').set({ ...auth(), 'X-Membership-Context': 'x'.repeat(8193) }).expect(422);
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('read endpoints return 200 (not 201) with no-store and pass only the path id and body', async () => {
    const s = app.getHttpServer();
    api.markRead.mockResolvedValue({ notificationId: id, version: 2 });
    api.markAllRead.mockResolvedValue({ scope: 'TENANT', cutoff: '2026-11-27T03:00:00Z', markedCount: 0 });
    api.unreadCount.mockResolvedValue({ scope: 'TENANT', unreadCount: 0, capped: false, asOf: '2026-11-27T03:00:00.000000Z' });
    const h = { ...auth(), 'X-Membership-Context': 'synthetic-context' };
    await request(s).post(`/v1/me/notifications/${id}/read`).set(h).send({ scope: 'TENANT' }).expect(200).expect('cache-control', 'no-store');
    expect(api.markRead.mock.calls[0].slice(1)).toEqual([id, { scope: 'TENANT' }]);
    await request(s).post('/v1/me/notifications/read-all').set(h).send({ scope: 'TENANT', cutoff: '2026-11-27T03:00:00Z' }).expect(200).expect('cache-control', 'no-store');
    expect(api.markRead).toHaveBeenCalledTimes(1); // read-all is not routed as a notification id
    await request(s).get('/v1/me/notifications/unread-count?scope=TENANT').set(h).expect(200).expect('cache-control', 'no-store');
    expect(api.unreadCount.mock.calls[0][1]).toEqual({ scope: 'TENANT' });
  });

  it('maps domain errors to contracted codes without echoing input; unconfigured identity is 503', async () => {
    const s = app.getHttpServer();
    api.markRead.mockRejectedValue(new IdentityError(404, 'NOT_FOUND'));
    const hidden = await request(s).post(`/v1/me/notifications/${id}/read`).set(auth()).send({ scope: 'PERSONAL' }).expect(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
    api.list.mockRejectedValue(new Error('SYNTHETIC_PII_MARKER 0912345678 secret'));
    const r = await request(s).get('/v1/me/notifications?scope=PERSONAL').set(auth()).expect(503);
    expect(JSON.stringify(r.body)).not.toMatch(/SYNTHETIC|0912345678|secret/);
    expect(Object.keys(r.body).sort()).toEqual(['code', 'correlationId', 'messageVi']);
    const u = await request(unconfigured.getHttpServer()).get('/v1/me/notifications?scope=PERSONAL').set(auth()).expect(503);
    expect(u.body.code).toBe('PROVIDER_NOT_CONFIGURED');
  });
});
