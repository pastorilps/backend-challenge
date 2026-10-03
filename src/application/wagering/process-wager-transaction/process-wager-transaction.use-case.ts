import { IdempotencyKey } from '../../../domain/wagering/value-objects/idempotency-key.js';
import { Money } from '../../../domain/wallet/value-objects/money.js';
import { hashPayload } from '../../../shared/utils/hash-payload.js';
import {
  IdempotentExecutionResult,
  ProcessWagerTransactionInput,
  WagerTransactionIdempotencyExecutor,
} from './idempotency.types.js';
import { WagerTransactionProcessor } from './wager-transaction-processor.js';

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly idempotencyExecutor: WagerTransactionIdempotencyExecutor,
    private readonly processor: WagerTransactionProcessor,
  ) {}

  execute(
    input: ProcessWagerTransactionInput,
    idempotencyKeyValue: string,
  ): Promise<IdempotentExecutionResult> {
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

    return this.idempotencyExecutor.execute(
      idempotencyKey.value,
      payloadHash,
      (transactionManager) =>
        this.processor.process(
          input,
          idempotencyKey.value,
          payloadHash,
          transactionManager,
        ),
    );
  }
}
