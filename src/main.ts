import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { AppErrorFilter } from './presentation/http/filters/app-error.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  app.useGlobalFilters(new AppErrorFilter());
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
