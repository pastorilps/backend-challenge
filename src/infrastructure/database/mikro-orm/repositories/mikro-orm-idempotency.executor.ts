import { EntityManager } from '@mikro-orm/postgresql';
import { IdempotencyConflictError } from '../../../../domain/wagering/errors/idempotency-conflict.error.js';
import {
  IdempotentExecutionResult,
  WagerTransactionIdempotencyExecutor,
  WagerTransactionOperation,
} from '../../../../application/wagering/process-wager-transaction/idempotency.types.js';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';
import { acquireTransactionAdvisoryLock } from './transaction-advisory-lock.js';

export class MikroOrmIdempotencyExecutor extends WagerTransactionIdempotencyExecutor {
  constructor(private readonly entityManager: EntityManager) {
    super();
  }

  override async execute(
    idempotencyKey: string,
    payloadHash: string,
    operation: WagerTransactionOperation,
  ): Promise<IdempotentExecutionResult> {
    return this.entityManager.transactional(async (transactionManager) => {
      await acquireTransactionAdvisoryLock(
        transactionManager,
        'idempotency',
        idempotencyKey,
      );

      const existing = await transactionManager.findOne(
        WagerTransactionOrmEntity,
        { idempotencyKey },
      );

      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new IdempotencyConflictError();
        }
        if (!existing.idempotencyResponse) {
          throw new Error(
            `Transaction ${existing.id} has no persisted idempotency response.`,
          );
        }
        return {
          response: {
            ...existing.idempotencyResponse,
            idempotentReplay: true,
          },
          replayed: true,
        };
      }

      const result = await operation(transactionManager);
      if (
        result.transaction.idempotencyKey !== idempotencyKey ||
        result.transaction.payloadHash !== payloadHash
      ) {
        throw new Error(
          'Operation transaction does not match its idempotency key and payload hash.',
        );
      }
      if (
        result.response.transactionId !== result.transaction.id ||
        result.response.idempotentReplay
      ) {
        throw new Error(
          'Operation response must refer to its transaction and be marked as a first execution.',
        );
      }

      result.transaction.idempotencyResponse = result.response;
      transactionManager.persist(result.transaction);
      await transactionManager.flush();

      return {
        response: result.response,
        replayed: false,
      };
    });
  }
}
