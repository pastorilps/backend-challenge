import { randomUUID } from 'node:crypto';
import { CurrencyMismatchError } from '../../../shared/errors/currency-mismatch.error.js';
import { InsufficientBalanceError } from '../errors/insufficient-balance.error.js';
import { Money } from '../value-objects/money.js';
import { LedgerDirection } from '../../ledger/enums/ledger-direction.js';
import { WalletLedgerEntry } from '../../ledger/entities/wallet-ledger-entry.js';

export interface OpenWalletProps {
  id?: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  transactionId: string;
  money: Money;
  at?: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    Wallet.assertIdentifier(props.playerId, 'playerId');
    const id = props.id ?? randomUUID();
    Wallet.assertIdentifier(id, 'id');
    if (props.initialBalance.isNegative()) {
      throw new RangeError('Initial wallet balance cannot be negative.');
    }

    const createdAt = Wallet.validDate(
      props.createdAt ?? new Date(),
      'createdAt',
    );
    return new Wallet(
      id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      createdAt,
      createdAt,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    Wallet.assertIdentifier(state.id, 'id');
    Wallet.assertIdentifier(state.playerId, 'playerId');
    if (
      state.balance.currency !== state.currency ||
      state.balance.isNegative()
    ) {
      throw new RangeError('Persisted wallet balance is invalid.');
    }
    if (!Number.isSafeInteger(state.version) || state.version < 1) {
      throw new RangeError(
        'Persisted wallet version must be a positive safe integer.',
      );
    }

    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      Wallet.validDate(state.createdAt, 'createdAt'),
      Wallet.validDate(state.updatedAt, 'updatedAt'),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (props.money.isNegative()) {
      throw new RangeError('Wallet debit amount cannot be negative.');
    }

    const at = Wallet.validDate(props.at ?? new Date(), 'at');
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(props.money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientBalanceError();
    }

    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
    this.applyBalance(balanceAfter, at);
    return entry;
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (props.money.isNegative()) {
      throw new RangeError('Wallet credit amount cannot be negative.');
    }

    const at = Wallet.validDate(props.at ?? new Date(), 'at');
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(props.money);
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
    this.applyBalance(balanceAfter, at);
    return entry;
  }

  private applyBalance(balance: Money, at: Date): void {
    if (balance.equals(this._balance)) {
      return;
    }
    this._balance = balance;
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private static assertIdentifier(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new RangeError(`${name} must be a non-empty string.`);
    }
  }

  private static validDate(value: Date, name: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new RangeError(`${name} must be a valid date.`);
    }
    return new Date(value);
  }
}
