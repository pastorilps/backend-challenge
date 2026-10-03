import { EntityManager } from '@mikro-orm/core';
import {
  IdempotentOperationResult,
  ProcessWagerTransactionInput,
} from './idempotency.types.js';

export abstract class WagerTransactionProcessor {
  abstract process(
    input: ProcessWagerTransactionInput,
    idempotencyKey: string,
    payloadHash: string,
    transactionManager: EntityManager,
  ): Promise<IdempotentOperationResult>;
}
