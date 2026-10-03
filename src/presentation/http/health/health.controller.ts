import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Res,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { DATABASE_ORM } from '../../../infrastructure/database/database.module.js';

interface DependencyStatus {
  status: 'up' | 'down' | 'not_configured';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DATABASE_ORM) private readonly orm: MikroORM) {}

  @Get('live')
  @ApiOperation({ summary: 'Check that the process is alive' })
  @ApiOkResponse({ description: 'Process is alive.' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check PostgreSQL and SQS readiness' })
  @ApiOkResponse({ description: 'Required dependencies are reachable.' })
  @ApiServiceUnavailableResponse({
    description: 'A required dependency is unavailable.',
  })
  async ready(@Res({ passthrough: true }) response: Response) {
    const [database, sqs] = await Promise.all([
      this.checkDatabase(),
      this.checkSqs(),
    ]);
    const ready = database.status === 'up' && sqs.status === 'up';
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ready ? 'ok' : 'error',
      checks: { database, sqs },
    };
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      await this.orm.em.getConnection().execute('select 1');
      return { status: 'up' };
    } catch (error) {
      this.logger.error(
        'PostgreSQL readiness check failed.',
        error instanceof Error ? error.stack : undefined,
      );
      return { status: 'down' };
    }
  }

  private async checkSqs(): Promise<DependencyStatus> {
    const healthcheckUrl = process.env.SQS_HEALTHCHECK_URL;
    if (!healthcheckUrl) {
      return { status: 'not_configured' };
    }

    try {
      const result = await fetch(healthcheckUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!result.ok) {
        this.logger.error(
          `SQS readiness endpoint returned HTTP ${result.status}.`,
        );
      }
      return { status: result.ok ? 'up' : 'down' };
    } catch (error) {
      this.logger.error(
        'SQS readiness check failed.',
        error instanceof Error ? error.stack : undefined,
      );
      return { status: 'down' };
    }
  }
}
