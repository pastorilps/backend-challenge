import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors/app.error.js';
import { IdempotencyKey } from '../value-objects/idempotency-key.js';
import { Money } from '../../wallet/value-objects/money.js';
import { LedgerDirection } from '../../ledger/enums/ledger-direction.js';
import { FailureCode } from '../enums/failure-code.js';
import { WagerTransactionKind } from '../enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.js';
import { InvalidTransactionStateError } from '../errors/invalid-transaction-state.error.js';

export interface CreateWagerTransactionProps {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string | IdempotencyKey;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface CreateOpeningTransactionProps {
  id?: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new AppError(
        'OPENING transactions can only be created internally.',
        'INTERNAL_TRANSACTION',
        400,
      );
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new AppError(
        'Unsupported wager transaction kind.',
        'INVALID_TRANSACTION',
        400,
      );
    }
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId?.trim()
    ) {
      throw new AppError(
        `${props.kind} transactions require a reference transaction.`,
        'REFERENCE_REQUIRED',
        400,
      );
    }

    const key =
      props.idempotencyKey instanceof IdempotencyKey
        ? props.idempotencyKey
        : IdempotencyKey.from(props.idempotencyKey);
    const id = props.id ?? randomUUID();
    const createdAt = WagerTransaction.validDate(
      props.createdAt ?? new Date(),
      'createdAt',
    );
    WagerTransaction.validateCommonProps({
      id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      payloadHash: props.payloadHash,
      money: props.money,
    });

    return new WagerTransaction(
      id,
      props.providerId,
      props.externalTransactionId,
      key.value,
      props.payloadHash.toLowerCase(),
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static opening(props: CreateOpeningTransactionProps): WagerTransaction {
    const id = props.id ?? randomUUID();
    const createdAt = WagerTransaction.validDate(
      props.createdAt ?? new Date(),
      'createdAt',
    );
    WagerTransaction.validateCommonProps({
      id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: '',
      gameId: '',
      payloadHash: '0'.repeat(64),
      money: props.money,
    });
    if (props.money.isNegative()) {
      throw new RangeError('Opening transaction amount cannot be negative.');
    }

    return new WagerTransaction(
      id,
      'internal',
      `opening:${props.walletId}`,
      `opening:${props.walletId}`,
      '0'.repeat(64),
      props.walletId,
      props.playerId,
      '',
      '',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransition('process');
    if (this.requiresReference() && !referenceTransactionId?.trim()) {
      throw new AppError(
        'A resolved reference transaction is required before processing.',
        'REFERENCE_REQUIRED',
        409,
      );
    }
    if (referenceTransactionId !== undefined) {
      WagerTransaction.assertIdentifier(
        referenceTransactionId,
        'referenceTransactionId',
      );
    }
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = WagerTransaction.validDate(at, 'processedAt');
    this._failureCode = undefined;
    this._status = WagerTransactionStatus.Processed;
  }

  markPendingReference(): void {
    this.assertCanTransition('wait for a reference');
    if (!this.requiresReference()) {
      throw new AppError(
        'Only REFUND and ROLLBACK transactions can wait for a reference.',
        'INVALID_TRANSACTION',
        409,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertCanTransition('reject');
    this._failureCode = WagerTransaction.validateFailureCode(code);
    this._processedAt = undefined;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertCanTransition('fail');
    this._failureCode = WagerTransaction.validateFailureCode(code);
    this._processedAt = undefined;
    this._status = WagerTransactionStatus.Failed;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash.toLowerCase();
  }

  assertValidReference(reference: WagerTransaction): void {
    const validKinds =
      this.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : this.kind === WagerTransactionKind.Rollback
          ? [
              WagerTransactionKind.Bet,
              WagerTransactionKind.Win,
              WagerTransactionKind.Refund,
            ]
          : [];

    if (
      !this.requiresReference() ||
      reference.status !== WagerTransactionStatus.Processed ||
      !validKinds.includes(reference.kind) ||
      this.providerId !== reference.providerId ||
      this.playerId !== reference.playerId ||
      this.walletId !== reference.walletId ||
      this.roundId !== reference.roundId ||
      this.money.currency !== reference.money.currency ||
      !this.money.equals(reference.money) ||
      this.referenceExternalTransactionId !== reference.externalTransactionId
    ) {
      throw new AppError(
        'Referenced transaction is not valid for this operation.',
        'INVALID_REFERENCE',
        422,
      );
    }
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new AppError(
            'A resolved reference is required to determine rollback direction.',
            'REFERENCE_REQUIRED',
            409,
          );
        }
        this.assertValidReference(reference);
        return reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new AppError(
          'LOSS transactions do not produce a ledger entry.',
          'LEDGER_NOT_APPLICABLE',
          409,
        );
    }
  }

  private assertCanTransition(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, action);
    }
  }

  private static validateCommonProps(props: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    payloadHash: string;
    money: Money;
  }): void {
    for (const name of [
      'id',
      'providerId',
      'externalTransactionId',
      'walletId',
      'playerId',
    ] as const) {
      WagerTransaction.assertIdentifier(props[name], name);
    }
    if (!(props.money instanceof Money) || props.money.isNegative()) {
      throw new AppError(
        'Transaction money must be a non-negative Money value.',
        'INVALID_MONEY',
        400,
      );
    }
    if (!/^[a-f\d]{64}$/i.test(props.payloadHash)) {
      throw new AppError(
        'Payload hash must be a SHA-256 hex digest.',
        'INVALID_PAYLOAD_HASH',
        400,
      );
    }
    if (typeof props.roundId !== 'string' || typeof props.gameId !== 'string') {
      throw new AppError(
        'Round and game identifiers must be strings.',
        'INVALID_TRANSACTION',
        400,
      );
    }
  }

  private static assertIdentifier(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError(
        `${name} must be a non-empty string.`,
        'INVALID_TRANSACTION',
        400,
      );
    }
  }

  private static validDate(value: Date, name: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new AppError(
        `${name} must be a valid date.`,
        'INVALID_TRANSACTION',
        400,
      );
    }
    return new Date(value);
  }

  private static validateFailureCode(code: FailureCode): FailureCode {
    if (!Object.values(FailureCode).includes(code)) {
      throw new AppError(
        'Failure code is not supported.',
        'INVALID_FAILURE_CODE',
        400,
      );
    }
    return code;
  }
}
