import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Controller, Get, Module } from '@nestjs/common';
import request from 'supertest';
import { SafeLogger } from './safe-logger';

const marker = 'SYNTHETIC_PII_OTP_KEY_TOKEN_DOCUMENT_MARKER';
@Controller()
class FailureController {
  @Get('/failure') fail(): never { throw new Error(marker, { cause: { phone: marker } }); }
}
@Module({ controllers: [FailureController] })
class FailureModule {}

describe('SafeLogger actual Nest output boundary (PT17 subset)', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  });
  afterEach(() => { Logger.overrideLogger(new SafeLogger()); jest.restoreAllMocks(); });
  function assertSafe() {
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(marker);
    for (const line of lines.filter(line => line.startsWith('{'))) expect(() => JSON.parse(line)).not.toThrow();
  }

  it('suppresses every level, nested/unknown fields, error causes, stack/context and serialization hooks', () => {
    const logger = new SafeLogger();
    const hook = jest.fn(() => { throw new Error(marker); });
    const object = { nested: [{ cccd: marker, phone: marker, bank_account: marker, otp: marker, token: marker, key: marker, rawDocuments: marker }], unknown: marker, toJSON: hook };
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
      logger[level](marker, object, new Error(marker, { cause: object }), marker);
      logger[level](object, Buffer.from(marker), cycle);
    }
    expect(hook).not.toHaveBeenCalled();
    assertSafe();
    expect(lines).toHaveLength(12);
    expect(new Set(lines.map(line => JSON.parse(line).level))).toEqual(new Set(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']));
  });

  it('routes static and contextual Nest loggers through the safe boundary', () => {
    Logger.overrideLogger(new SafeLogger());
    Logger.error(marker, marker, marker);
    new Logger(marker).warn({ phone: marker });
    assertSafe();
    expect(lines).toHaveLength(2);
  });

  it('redacts real Nest unhandled HTTP failures and startup logs', async () => {
    const app = (await Test.createTestingModule({ imports: [FailureModule] }).setLogger(new SafeLogger()).compile()).createNestApplication();
    app.useLogger(new SafeLogger());
    try {
      await app.init();
      const result = await request(app.getHttpServer()).get('/failure').expect(500);
      expect(JSON.stringify(result.body)).not.toContain(marker);
      assertSafe();
      expect(lines.some(line => line.startsWith('{') && JSON.parse(line).level === 'error')).toBe(true);
    } finally { await app.close(); }
  });

  it('preserves validated listener address but suppresses credentials/query/path/invalid addresses', () => {
    const logger = new SafeLogger();
    logger.listening('http://127.0.0.1:34567');
    expect(lines.join('')).toContain('Listening on http://127.0.0.1:34567');
    for (const url of [marker, `http://${marker}@localhost:3000`, `http://localhost:3000/${marker}`, `http://localhost:3000?token=${marker}`, `http://${marker}:3000`, `http://localhost:3000#${marker}`]) logger.listening(url);
    assertSafe();
    expect(lines.filter(line => JSON.parse(line).message === 'SERVICE_LISTENING')).toHaveLength(6);
  });
});
