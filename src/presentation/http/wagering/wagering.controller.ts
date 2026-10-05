import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiParam,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { GetWagerTransactionUseCase } from '../../../application/wagering/get-wager-transaction/get-wager-transaction.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../../application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import { AppError } from '../../../shared/errors/app.error.js';
import { WagerTransactionStatus } from '../../../domain/wagering/enums/wager-transaction-status.js';
import { ProviderIdentityGuard } from '../auth/provider-identity.guard.js';
import {
  CreateWagerTransactionDto,
  ProviderTransactionParamsDto,
  WagerTransactionIdParamsDto,
} from './dto/create-wager-transaction.dto.js';
import {
  WagerTransactionDetailsResponseDto,
  WagerTransactionResponseDto,
} from './dto/wager-transaction-response.dto.js';

@ApiTags('wagering')
@ApiBearerAuth('cognito-jwt')
@UseGuards(ProviderIdentityGuard)
@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly getWagerTransaction: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({ summary: 'Submit an idempotent wager transaction' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Stable key for retries; the key is not part of the payload hash.',
  })
  @ApiOkResponse({
    description: 'Transaction processed or replayed.',
    type: WagerTransactionResponseDto,
  })
  @ApiAcceptedResponse({
    description: 'Transaction is waiting for its reference.',
    type: WagerTransactionResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid payload or missing idempotency key.',
  })
  @ApiConflictResponse({
    description: 'Idempotency key or provider transaction conflict.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Transaction rejected by business rules.',
    type: WagerTransactionResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'A transient database failure prevented processing.',
  })
  async submit(
    @Body() input: CreateWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new AppError(
        'Idempotency-Key header is required.',
        'IDEMPOTENCY_KEY_REQUIRED',
        400,
      );
    }

    const result = await this.processWagerTransaction.execute(
      input,
      idempotencyKey,
    );
    response.status(this.statusFor(result.response.status));
    return result.response;
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({
    summary: 'Get a wager transaction by its internal identifier',
  })
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Transaction found.',
    type: WagerTransactionDetailsResponseDto,
  })
  async getById(
    @Param() params: WagerTransactionIdParamsDto,
    @Req() request: Request & { auth?: { providerId: string } },
  ) {
    const transaction = await this.getWagerTransaction.byId(
      params.transactionId,
    );
    if (transaction.providerId !== request.auth?.providerId) {
      throw new AppError(
        'Wager transaction was not found.',
        'WAGER_TRANSACTION_NOT_FOUND',
        404,
      );
    }
    return transaction;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({
    summary: 'Get a wager transaction by provider and external identifier',
  })
  @ApiParam({
    name: 'providerId',
    schema: { type: 'string', maxLength: 100, example: 'provider-a' },
  })
  @ApiParam({
    name: 'externalTransactionId',
    schema: {
      type: 'string',
      maxLength: 255,
      example: 'transaction-143',
    },
  })
  @ApiOkResponse({
    description: 'Transaction found.',
    type: WagerTransactionDetailsResponseDto,
  })
  getByProviderExternalId(
    @Param() params: ProviderTransactionParamsDto,
    @Req() request: Request & { auth?: { providerId: string } },
  ) {
    if (params.providerId !== request.auth?.providerId) {
      throw new AppError(
        'Wager transaction was not found.',
        'WAGER_TRANSACTION_NOT_FOUND',
        404,
      );
    }
    return this.getWagerTransaction.byProviderExternalId(
      params.providerId,
      params.externalTransactionId,
    );
  }

  private statusFor(status: WagerTransactionStatus): number {
    switch (status) {
      case WagerTransactionStatus.Processed:
        return HttpStatus.OK;
      case WagerTransactionStatus.PendingReference:
        return HttpStatus.ACCEPTED;
      case WagerTransactionStatus.Rejected:
        return HttpStatus.UNPROCESSABLE_ENTITY;
      case WagerTransactionStatus.Pending:
      case WagerTransactionStatus.Failed:
        return HttpStatus.SERVICE_UNAVAILABLE;
    }
  }
}
