import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { AppError } from '../../../shared/errors/app.error.js';

@Catch(
  AppError,
  UniqueConstraintViolationException,
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
)
export class AppErrorFilter implements ExceptionFilter<Error> {
  catch(exception: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): {
        json(body: { statusCode: number; code: string; message: string }): void;
      };
    }>();

    if (exception instanceof AppError) {
      response.status(exception.statusCode).json({
        statusCode: exception.statusCode,
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof UniqueConstraintViolationException) {
      response.status(409).json({
        statusCode: 409,
        code: 'RESOURCE_CONFLICT',
        message: 'A resource with the same unique identifier already exists.',
      });
      return;
    }

    const message =
      exception instanceof ConnectionException
        ? 'Database is temporarily unavailable.'
        : 'Database operation could not be completed; retry the request.';
    response.status(503).json({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
      message,
    });
  }
}
