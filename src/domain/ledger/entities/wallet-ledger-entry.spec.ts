import { describe, expect, it } from 'vitest';
import { LedgerDirection } from '../enums/ledger-direction.js';
import { Money } from '../../wallet/value-objects/money.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';

describe('WalletLedgerEntry', () => {
  it('rejects an entry whose resulting balance does not match its movement', () => {
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '2.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '9.00', currency: 'BRL' }),
      }),
    ).toThrow('Ledger balance after does not match');
  });
});
