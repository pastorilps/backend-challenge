import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionKind } from '../../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/enums/wager-transaction-status.js';
import {
  IdempotentExecutionResult,
  WagerTransactionIdempotencyExecutor,
  WagerTransactionOperation,
} from './idempotency.types.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';
import { WagerTransactionProcessor } from './wager-transaction-processor.js';

class TestIdempotencyExecutor extends WagerTransactionIdempotencyExecutor {
  received?: {
    key: string;
    hash: string;
    operation: WagerTransactionOperation;
  };

  override execute(
    idempotencyKey: string,
    payloadHash: string,
    operation: WagerTransactionOperation,
  ): Promise<IdempotentExecutionResult> {
    this.received = { key: idempotencyKey, hash: payloadHash, operation };
    return Promise.resolve({
      response: {
        transactionId: 'transaction-1',
        status: WagerTransactionStatus.Processed,
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: false,
      },
      replayed: false,
    });
  }
}

class TestProcessor extends WagerTransactionProcessor {
  process = vi.fn();
}

describe('ProcessWagerTransactionUseCase idempotency input', () => {
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

    expect(() =>
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
    ).toThrow();
    expect(executor.received).toBeUndefined();
  });
});
