import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let module: TestingModule;
  let controller: HealthController;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    controller = module.get(HealthController);
  });

  afterAll(async () => { await module.close(); });

  it('returns only the process health contract', () => {
    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });
});
