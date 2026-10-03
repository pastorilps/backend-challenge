import { EntityManager } from '@mikro-orm/postgresql';
import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionStatus } from '../../../../domain/wagering/enums/wager-transaction-status.js';
import { IdempotencyConflictError } from '../../../../domain/wagering/errors/idempotency-conflict.error.js';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';
import { MikroOrmIdempotencyExecutor } from './mikro-orm-idempotency.executor.js';

function existingTransaction(payloadHash: string): WagerTransactionOrmEntity {
  return {
    id: 'transaction-1',
    idempotencyKey: 'key-1',
    payloadHash,
    idempotencyResponse: {
      transactionId: 'transaction-1',
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    },
  } as WagerTransactionOrmEntity;
}

function createExecutor(existing?: WagerTransactionOrmEntity) {
  const transactionManager = {
    execute: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn().mockResolvedValue(existing ?? null),
    persist: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  };
  const entityManager = {
    transactional: vi.fn(
      async <Result>(
        callback: (manager: typeof transactionManager) => Promise<Result>,
      ) => callback(transactionManager),
    ),
  };
  return {
    executor: new MikroOrmIdempotencyExecutor(
      entityManager as unknown as EntityManager,
    ),
    entityManager,
    transactionManager,
  };
}

describe('MikroOrmIdempotencyExecutor', () => {
  it('returns the persisted original response as a replay without rerunning the operation', async () => {
    const { executor, transactionManager } = createExecutor(
      existingTransaction('a'.repeat(64)),
    );
    const operation = vi.fn();

    const result = await executor.execute('key-1', 'a'.repeat(64), operation);

    expect(result).toEqual({
      response: {
        transactionId: 'transaction-1',
        status: WagerTransactionStatus.Processed,
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: true,
      },
      replayed: true,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(transactionManager.execute).toHaveBeenCalledWith(
      'select pg_advisory_xact_lock(hashtextextended(?, 0))',
      ['key-1'],
    );
    expect(transactionManager.persist).not.toHaveBeenCalled();
  });

  it('rejects reuse of a key with a different payload hash', async () => {
    const { executor } = createExecutor(existingTransaction('a'.repeat(64)));

    await expect(
      executor.execute('key-1', 'b'.repeat(64), vi.fn()),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('stores the first response on the transaction in the same database transaction', async () => {
    const { executor, entityManager, transactionManager } = createExecutor();
    const transaction = {
      id: 'transaction-1',
      idempotencyKey: 'key-1',
      payloadHash: 'a'.repeat(64),
      idempotencyResponse: null,
    } as WagerTransactionOrmEntity;
    const response = {
      transactionId: transaction.id,
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false as const,
    };

    const result = await executor.execute(
      'key-1',
      'a'.repeat(64),
      async () => ({
        transaction,
        response,
      }),
    );

    expect(result.replayed).toBe(false);
    expect(transaction.idempotencyResponse).toEqual(response);
    expect(transactionManager.persist).toHaveBeenCalledWith(transaction);
    expect(transactionManager.flush).toHaveBeenCalledOnce();
    expect(entityManager.transactional).toHaveBeenCalledOnce();
  });
});
