import { describe, expect, it } from 'vitest';
import { LedgerDirection } from '../../ledger/enums/ledger-direction.js';
import { InsufficientBalanceError } from '../errors/insufficient-balance.error.js';
import { Money } from '../value-objects/money.js';
import { Wallet } from './wallet.js';

describe('Wallet', () => {
  it('increments its version only when the balance changes and returns matching ledger entries', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: now,
    });

    const debit = wallet.debit({
      transactionId: 'transaction-1',
      money: Money.from({ amount: '2.50', currency: 'BRL' }),
      at: new Date(now.getTime() + 1_000),
    });

    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe('7.50');
    expect(wallet.version).toBe(2);

    wallet.credit({
      transactionId: 'transaction-2',
      money: Money.zero('BRL'),
      at: new Date(now.getTime() + 2_000),
    });
    expect(wallet.version).toBe(2);
  });

  it('does not allow the balance to become negative', () => {
    const wallet = Wallet.open({
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.debit({
        transactionId: 'transaction-1',
        money: Money.from({ amount: '1.01', currency: 'BRL' }),
      }),
    ).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toString()).toBe('1.00');
    expect(wallet.version).toBe(1);
  });
});
