import { ValidationError, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppErrorFilter } from './filters/app-error.filter.js';
import { AppError } from '../../shared/errors/app.error.js';

function validationMessage(errors: ValidationError[]): string {
  const messages: string[] = [];
  for (const error of errors) {
    messages.push(...Object.values(error.constraints ?? {}));
    messages.push(validationMessage(error.children ?? []));
  }
  return messages.filter(Boolean).join('; ');
}

export function configureHttpApplication(app: INestApplication): void {
  app.useGlobalFilters(new AppErrorFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors: ValidationError[]) =>
        new AppError(
          validationMessage(errors) || 'Request payload is invalid.',
          'INVALID_PAYLOAD',
          400,
        ),
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Wagering Wallet API')
    .setDescription(
      'HTTP API for wallets and idempotent wager transaction processing.',
    )
    .setVersion('1.0.0')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);
}
