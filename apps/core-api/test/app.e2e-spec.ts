import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('Process health (HTTP)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it('GET /health returns 200 JSON with only process status, without credentials', async () => {
    await request(app.getHttpServer()).get('/health')
      .expect(200).expect('Content-Type', /json/).expect({ status: 'ok' });
  });

  it('POST /health cannot mutate anything', async () => {
    await request(app.getHttpServer()).post('/health').expect(404);
  });

  it('exposes no unauthenticated or scaffold claim API (CLM-02 routes require verified identity)', async () => {
    const server = app.getHttpServer();
    for (const r of [request(server).post('/v1/claims').send({}), request(server).get('/v1/claims'),
      request(server).get('/v1/claims/12345678-1234-1234-1234-123456789abc'),
      request(server).post('/v1/claims/12345678-1234-1234-1234-123456789abc/documents').send({})]) {
      const res = await r.expect(401).expect('Cache-Control', 'no-store');
      expect(Object.keys(res.body).sort()).toEqual(['code', 'correlationId', 'messageVi']);
    }
  });
});
