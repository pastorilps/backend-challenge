import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionKind } from '../../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/enums/wager-transaction-status.js';
import {
  IdempotentExecutionResult,
  WagerTransactionInboxReceipt,
  WagerTransactionIdempotencyExecutor,
  WagerTransactionOperation,
} from './idempotency.types.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';
import { WagerTransactionProcessor } from './wager-transaction-processor.js';
import { ApplicationMetrics } from '../../observability/application-metrics.js';

class TestIdempotencyExecutor extends WagerTransactionIdempotencyExecutor {
  replayed = false;
  received?: {
    key: string;
    hash: string;
    operation: WagerTransactionOperation;
    inboxReceipt?: WagerTransactionInboxReceipt;
  };

  override execute(
    idempotencyKey: string,
    payloadHash: string,
    operation: WagerTransactionOperation,
    inboxReceipt?: WagerTransactionInboxReceipt,
  ): Promise<IdempotentExecutionResult> {
    this.received = {
      key: idempotencyKey,
      hash: payloadHash,
      operation,
      inboxReceipt,
    };
    return Promise.resolve({
      response: {
        transactionId: 'transaction-1',
        status: WagerTransactionStatus.Processed,
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: false,
      },
      replayed: this.replayed,
    });
  }
}

class TestProcessor extends WagerTransactionProcessor {
  process = vi.fn();
}

describe('ProcessWagerTransactionUseCase idempotency input', () => {
  function createMetrics(): ApplicationMetrics & {
    recordTransactionStatus: ReturnType<typeof vi.fn>;
    incrementDuplicateCount: ReturnType<typeof vi.fn>;
    observeProcessingLatency: ReturnType<typeof vi.fn>;
  } {
    return {
      incrementMismatchCount: vi.fn(() => {}),
      recordTransactionStatus: vi.fn((_status: string) => {}),
      incrementDuplicateCount: vi.fn(() => {}),
      incrementRetry: vi.fn((_source: 'sqs' | 'outbox') => {}),
      incrementDeadLetterCount: vi.fn(() => {}),
      incrementLockConflictCount: vi.fn(() => {}),
      observeProcessingLatency: vi.fn((_milliseconds: number) => {}),
      observeOutboxLag: vi.fn((_milliseconds: number) => {}),
    };
  }

  it('hashes normalized business fields and keeps the header key out of the payload hash', async () => {
    const executor = new TestIdempotencyExecutor();
    const processor = new TestProcessor();
    const useCase = new ProcessWagerTransactionUseCase(executor, processor);
    const input = {
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.0', currency: 'BRL' },
    } as const;

    await useCase.execute(input, 'provider-1:external-1');
    const firstHash = executor.received?.hash;
    await useCase.execute(
      { ...input, money: { amount: '25.00', currency: 'BRL' } },
      'a-different-idempotency-key',
    );

    expect(executor.received?.key).toBe('a-different-idempotency-key');
    expect(executor.received?.hash).toBe(firstHash);
    expect(executor.received?.operation).toBeTypeOf('function');
  });

  it('rejects an invalid or missing idempotency key before processing', async () => {
    const executor = new TestIdempotencyExecutor();
    const useCase = new ProcessWagerTransactionUseCase(
      executor,
      new TestProcessor(),
    );

    await expect(
      useCase.execute(
        {
          providerId: 'provider-1',
          externalTransactionId: 'external-1',
          playerId: 'player-1',
          walletId: 'wallet-1',
          roundId: 'round-1',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '25.00', currency: 'BRL' },
        },
        '',
      ),
    ).rejects.toThrow();
    expect(executor.received).toBeUndefined();
  });

  it('forwards an SQS inbox receipt to the transaction executor', async () => {
    const executor = new TestIdempotencyExecutor();
    const useCase = new ProcessWagerTransactionUseCase(
      executor,
      new TestProcessor(),
    );
    const inboxReceipt: WagerTransactionInboxReceipt = {
      consumerName: 'wager-transaction-consumer',
      messageId: 'message-1',
      payloadHash: 'a'.repeat(64),
      payloadJson: { messageId: 'message-1' },
      attempts: 1,
    };

    await useCase.execute(
      {
        providerId: 'provider-1',
        externalTransactionId: 'external-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
      'provider-1:external-1',
      inboxReceipt,
    );

    expect(executor.received?.inboxReceipt).toEqual(inboxReceipt);
  });

  it('records the final status and processing latency', async () => {
    const executor = new TestIdempotencyExecutor();
    const metrics = createMetrics();
    const useCase = new ProcessWagerTransactionUseCase(
      executor,
      new TestProcessor(),
      metrics,
    );
    const input = {
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    } as const;

    await useCase.execute(input, 'key-1');

    expect(metrics.recordTransactionStatus).toHaveBeenCalledWith(
      WagerTransactionStatus.Processed,
    );
    expect(metrics.observeProcessingLatency).toHaveBeenCalledWith(
      expect.any(Number),
    );
  });

  it('counts idempotent replays as detected duplicates', async () => {
    const executor = new TestIdempotencyExecutor();
    executor.replayed = true;
    const metrics = createMetrics();
    const useCase = new ProcessWagerTransactionUseCase(
      executor,
      new TestProcessor(),
      metrics,
    );

    await useCase.execute(
      {
        providerId: 'provider-1',
        externalTransactionId: 'external-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
      'key-1',
    );

    expect(metrics.incrementDuplicateCount).toHaveBeenCalledOnce();
  });
});
