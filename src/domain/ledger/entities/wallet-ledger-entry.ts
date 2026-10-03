import { randomUUID } from 'node:crypto';
import { Money } from '../../wallet/value-objects/money.js';
import { LedgerDirection } from '../enums/ledger-direction.js';

export interface CreateLedgerEntryProps {
  id?: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertIdentifier(props.walletId, 'walletId');
    WalletLedgerEntry.assertIdentifier(props.transactionId, 'transactionId');
    WalletLedgerEntry.assertMoney(props.money, 'money');
    WalletLedgerEntry.assertMoney(props.balanceBefore, 'balanceBefore');
    WalletLedgerEntry.assertMoney(props.balanceAfter, 'balanceAfter');

    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new RangeError('Ledger amounts must use the same currency.');
    }
    if (
      props.money.isNegative() ||
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new RangeError('Ledger amounts and balances cannot be negative.');
    }
    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new RangeError('Ledger direction is invalid.');
    }

    const id = props.id ?? randomUUID();
    WalletLedgerEntry.assertIdentifier(id, 'id');
    const createdAt = WalletLedgerEntry.validDate(
      props.createdAt ?? new Date(),
    );
    const entry = new WalletLedgerEntry(
      id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      createdAt,
    );
    if (!entry.isBalanced()) {
      throw new RangeError(
        'Ledger balance after does not match its direction and amount.',
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  isBalanced(): boolean {
    const expectedBalance =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return (
      !expectedBalance.isNegative() && expectedBalance.equals(this.balanceAfter)
    );
  }

  private static assertIdentifier(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new RangeError(`${name} must be a non-empty string.`);
    }
  }

  private static assertMoney(value: Money, name: string): void {
    if (!(value instanceof Money)) {
      throw new TypeError(`${name} must be a Money value.`);
    }
  }

  private static validDate(value: Date): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new RangeError('Ledger creation date must be valid.');
    }
    return new Date(value);
  }
}
