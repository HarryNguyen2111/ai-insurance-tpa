import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
  Logger.log(`Listening on ${await app.getUrl()}`, 'Bootstrap');
}
void bootstrap();
