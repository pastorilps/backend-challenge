import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { AppError } from '../../../shared/errors/app.error.js';

@Catch(AppError)
export class AppErrorFilter implements ExceptionFilter<AppError> {
  catch(exception: AppError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): {
        json(body: { statusCode: number; code: string; message: string }): void;
      };
    }>();

    response.status(exception.statusCode).json({
      statusCode: exception.statusCode,
      code: exception.code,
      message: exception.message,
    });
  }
}
