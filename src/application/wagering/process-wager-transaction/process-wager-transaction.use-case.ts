import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { IdempotencyKey } from '../../../domain/wagering/value-objects/idempotency-key.js';
import { Money } from '../../../domain/wallet/value-objects/money.js';
import { AppError } from '../../../shared/errors/app.error.js';
import { hashPayload } from '../../../shared/utils/hash-payload.js';
import {
  IdempotentExecutionResult,
  ProcessWagerTransactionInput,
  WagerTransactionInboxReceipt,
  WagerTransactionIdempotencyExecutor,
} from './idempotency.types.js';
import { WagerTransactionProcessor } from './wager-transaction-processor.js';
import { ApplicationMetrics } from '../../observability/application-metrics.js';

export class ProcessWagerTransactionUseCase {
  private readonly logger = new Logger(ProcessWagerTransactionUseCase.name);

  constructor(
    private readonly idempotencyExecutor: WagerTransactionIdempotencyExecutor,
    private readonly processor: WagerTransactionProcessor,
    private readonly metrics?: ApplicationMetrics,
  ) {}

  async execute(
    input: ProcessWagerTransactionInput,
    idempotencyKeyValue: string,
    inboxReceipt?: WagerTransactionInboxReceipt,
  ): Promise<IdempotentExecutionResult> {
    const startedAt = performance.now();
    const correlationId = inboxReceipt?.correlationId ?? randomUUID();
    try {
      const idempotencyKey = IdempotencyKey.from(idempotencyKeyValue);
      const money = Money.from(input.money).toJSON();
      const payloadHash = hashPayload({
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money: { amount: money.amount, currency: money.currency },
        ...(input.referenceExternalTransactionId === undefined
          ? {}
          : {
              referenceExternalTransactionId:
                input.referenceExternalTransactionId,
            }),
      });

      const result = await this.idempotencyExecutor.execute(
        idempotencyKey.value,
        payloadHash,
        (transactionManager) =>
          this.processor.process(
            input,
            idempotencyKey.value,
            payloadHash,
            transactionManager,
          ),
        inboxReceipt,
      );
      this.metrics?.recordTransactionStatus(result.response.status);
      if (result.replayed) {
        this.metrics?.incrementDuplicateCount();
      }
      this.logger.log(
        JSON.stringify({
          event: 'wager_transaction_processed',
          correlationId,
          messageId: inboxReceipt?.messageId ?? null,
          transactionId: result.response.transactionId,
          walletId: input.walletId,
          providerId: input.providerId,
          status: result.response.status,
          idempotentReplay: result.replayed,
        }),
      );
      return result;
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'DUPLICATE_EXTERNAL_TRANSACTION' ||
          error.code === 'IDEMPOTENCY_CONFLICT')
      ) {
        this.metrics?.incrementDuplicateCount();
      }
      this.logger.warn(
        JSON.stringify({
          event: 'wager_transaction_processing_failed',
          correlationId,
          messageId: inboxReceipt?.messageId ?? null,
          transactionId: null,
          walletId: input.walletId,
          providerId: input.providerId,
          code: error instanceof AppError ? error.code : 'PROCESSING_FAILED',
        }),
      );
      throw error;
    } finally {
      this.metrics?.observeProcessingLatency(performance.now() - startedAt);
    }
  }
}
