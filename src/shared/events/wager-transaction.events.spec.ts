import { describe, expect, it } from 'vitest';
import { Money } from '../../domain/wallet/value-objects/money.js';
import { WagerTransactionKind } from '../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/wagering/enums/wager-transaction-status.js';
import { WagerTransaction } from '../../domain/wagering/entities/wager-transaction.js';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from './wager-transaction.events.js';
import { Wallet } from '../../domain/wallet/entities/wallet.js';

describe('integration events', () => {
  it('serializes a processed transaction as a versioned event envelope', () => {
    const transaction = WagerTransaction.create({
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      idempotencyKey: 'key-1',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    transaction.markProcessed(undefined, new Date('2026-01-01T00:00:00.000Z'));
    const event = WagerTransactionProcessed.from(transaction, {
      correlationId: 'correlation-1',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const envelope = event.toJSON();

    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(envelope.data.status).toBe(WagerTransactionStatus.Processed);
    expect(envelope.data.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(envelope.occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('builds balance events from a consistent wallet and ledger entry', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });
    const entry = wallet.credit({
      transactionId: 'transaction-1',
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
    });
    const event = WalletBalanceChanged.from(wallet, entry, {
      correlationId: 'correlation-1',
    });

    expect(event.toJSON().data.balanceAfter).toEqual({
      amount: '5.00',
      currency: 'BRL',
    });
    expect(event.toJSON().data.walletVersion).toBe(2);
  });
});
