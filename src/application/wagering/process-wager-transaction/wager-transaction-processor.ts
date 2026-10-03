import { EntityManager } from '@mikro-orm/core';
import {
  IdempotentOperationResult,
  ProcessWagerTransactionInput,
} from './idempotency.types.js';

export abstract class PendingReferenceReprocessor {
  abstract reprocessPendingReferences(
    entityManager: EntityManager,
    now: Date,
    limit: number,
  ): Promise<number>;
}

export abstract class WagerTransactionProcessor {
  abstract process(
    input: ProcessWagerTransactionInput,
    idempotencyKey: string,
    payloadHash: string,
    transactionManager: EntityManager,
  ): Promise<IdempotentOperationResult>;
}
