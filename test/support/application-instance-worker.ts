import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from '../../dist/app.module.js';
import { configureHttpApplication } from '../../dist/presentation/http/configure-http-application.js';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    logger: ['error'],
  });
  configureHttpApplication(app);
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Application instance did not bind to a TCP port.');
  }
  console.log(
    `APPLICATION_INSTANCE_READY:${JSON.stringify({
      pid: process.pid,
      port: address.port,
    })}`,
  );

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (input) => {
    if (input.includes('shutdown')) {
      void app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        },
      );
    }
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
