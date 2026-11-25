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

  it('does not expose a scaffold claim API', async () => {
    await request(app.getHttpServer()).post('/v1/claims').send({}).expect(404);
  });
});
