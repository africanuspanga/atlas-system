import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { resolveWebOrigin } from './config';
import { initSentry } from './observability/sentry';
import { LoggingInterceptor } from './observability/logging.interceptor';

async function bootstrap() {
  initSentry();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Security headers on every response. CSP is disabled: this is a JSON API
  // consumed by the web app, not a page server — a CSP here would be noise.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Behind a reverse proxy the per-IP throttler must read the real client IP
  // from X-Forwarded-For, or every request buckets under the proxy's single
  // IP. Trust a fixed hop count (default 1) — NEVER `true`, which would let a
  // client spoof X-Forwarded-For and evade per-IP limits. Override with
  // TRUST_PROXY when more proxy layers sit in front.
  const trustProxyEnv = process.env.TRUST_PROXY;
  const trustProxy =
    trustProxyEnv === undefined
      ? 1
      : /^\d+$/.test(trustProxyEnv)
        ? Number(trustProxyEnv)
        : trustProxyEnv;
  app.set('trust proxy', trustProxy);

  app.setGlobalPrefix('api/v1');
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.enableCors({
    origin: resolveWebOrigin(),
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen(Number(process.env.API_PORT ?? 4000));
}
void bootstrap();
