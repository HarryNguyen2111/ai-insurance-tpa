import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SafeLogger } from './logging/safe-logger';

const logger = new SafeLogger();
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
  logger.listening(await app.getUrl());
}
void bootstrap().catch(() => {
  logger.error('BOOTSTRAP_FAILED');
  process.exitCode = 1;
});
