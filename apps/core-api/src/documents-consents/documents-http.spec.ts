import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IdentityTenantModule } from '../identity-tenant/identity.module.ts';
import { OidcVerifier } from '../identity-tenant/oidc-verifier.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import { syntheticIssuer } from '../../test/fixtures/synthetic-issuer.ts';
import { DocumentsModule } from './documents.module.ts';
describe('DOC-01 HTTP authentication and async contract', () => {
  let app: INestApplication, issuer: Awaited<ReturnType<typeof syntheticIssuer>>, token: string;
  const api = { consent:jest.fn(),presign:jest.fn(),complete:jest.fn(),get:jest.fn() };
  const id='12345678-1234-1234-1234-123456789abc';
  const headers=()=>({ Authorization:`Bearer ${token}`,'X-Membership-Context':'synthetic-context','Idempotency-Key':'synthetic-document-key-001' });
  beforeAll(async()=>{
    issuer=await syntheticIssuer(); token=await issuer.token('SYNTHETIC_PII_MARKER');
    const identity=IdentityTenantModule.register({ verifier:new OidcVerifier(issuer.profile) });
    const m=await Test.createTestingModule({ imports:[identity,DocumentsModule.register({identity,api})] }).compile();
    app=m.createNestApplication({logger:false});await app.init();
  });
  afterAll(async()=>{await app.close();await issuer.close();});
  beforeEach(()=>jest.resetAllMocks());
  it('requires bearer, membership and idempotency; rejects client tenant assertions',async()=>{
    await request(app.getHttpServer()).post('/v1/claims/upload-url').send({}).expect(401);
    await request(app.getHttpServer()).post('/v1/consents').set({...headers(),'X-Tenant-Id':id}).send({}).expect(403);
    await request(app.getHttpServer()).post('/v1/consents').set('Authorization',`Bearer ${token}`).send({}).expect(422);
    await request(app.getHttpServer()).post('/v1/consents').set({Authorization:`Bearer ${token}`,'X-Membership-Context':'ctx'}).send({}).expect(422);
    expect(api.consent).not.toHaveBeenCalled();expect(api.presign).not.toHaveBeenCalled();
  });
  it('returns async Location, Retry-After and no-store; replays original response',async()=>{
    api.complete.mockResolvedValue({status:202,body:{documentId:id,scanStatus:'QUARANTINED'},replayed:true});
    const r=await request(app.getHttpServer()).post(`/v1/uploads/${id}/complete`).set(headers()).send({sha256:'a'.repeat(64),sizeBytes:20}).expect(202);
    expect(r.headers).toMatchObject({'cache-control':'no-store','location':`/v1/documents/${id}`,'retry-after':'2','idempotent-replayed':'true'});
    expect(api.complete.mock.calls[0][0]).toMatchObject({membershipContext:'synthetic-context',idempotencyKey:'synthetic-document-key-001'});
    expect(api.complete.mock.calls[0][0]).not.toHaveProperty('tenantId');
  });
  it('does not expose provider errors or PII in failures',async()=>{
    api.get.mockRejectedValue(new Error('SYNTHETIC_PII_MARKER secret'));
    const r=await request(app.getHttpServer()).get(`/v1/documents/${id}`).set(headers()).expect(503);
    expect(JSON.stringify(r.body)).not.toMatch(/SYNTHETIC|secret/);
    api.consent.mockRejectedValue(new IdentityError(422,'DOMAIN_VIOLATION'));
    await request(app.getHttpServer()).post('/v1/consents').set(headers()).send({}).expect(422);
  });
});
