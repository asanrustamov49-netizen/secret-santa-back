import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Prefix, cookies, CORS, validation — shared with the e2e tests
  configureApp(app);

  app.enableShutdownHooks();

  await app.listen(env.port);
  Logger.log(
    `API running at ${process.env.BACKEND_URL ?? `http://localhost:${env.port}`}/api`,
    'Bootstrap',
  );
}

void bootstrap();
