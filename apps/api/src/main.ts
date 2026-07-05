import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { resolveWebOrigin } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: resolveWebOrigin(),
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen(Number(process.env.API_PORT ?? 4000));
}
void bootstrap();
