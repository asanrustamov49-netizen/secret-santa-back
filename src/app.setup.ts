import { type INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { env } from './config/env';

/**
 * Everything main.ts applies to the app besides listening — shared with the e2e
 * tests so they exercise the same prefix, cookies and validation as production.
 */
export function configureApp(app: INestApplication) {
  // All routes live under /api (e.g. /api/events)
  app.setGlobalPrefix('api');

  // Auth tokens live in httpOnly cookies
  app.use(cookieParser());

  app.enableCors({
    origin: env.frontendUrl,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip properties that are not in the DTO
      forbidNonWhitelisted: true, // …and reject the request if any were sent
      transform: true, // turn payloads into DTO class instances
      transformOptions: { enableImplicitConversion: true }, // "5" → 5 for query/params
    }),
  );

  return app;
}
