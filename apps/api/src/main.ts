import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { resolveWebOrigin } from './config';
import { initSentry } from './observability/sentry';
import { LoggingInterceptor } from './observability/logging.interceptor';

async function bootstrap() {
  initSentry();
  const app = await NestFactory.create(AppModule);

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
