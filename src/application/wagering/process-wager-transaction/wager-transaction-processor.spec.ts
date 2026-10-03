import { EntityManager } from '@mikro-orm/core';
import { describe, expect, it, vi } from 'vitest';
import { MikroOrmWagerTransactionProcessor } from '../../../infrastructure/database/mikro-orm/repositories/mikro-orm-wager-transaction.processor.js';
import { ProcessWagerTransactionInput } from './idempotency.types.js';
import { FailureCode } from '../../../domain/wagering/enums/failure-code.js';
import { WagerTransactionKind } from '../../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/enums/wager-transaction-status.js';
import { LockMode } from '@mikro-orm/core';
import { OutboxMessageOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/outbox-message.orm-entity.js';
import { WagerTransactionOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet.orm-entity.js';

const baseInput: ProcessWagerTransactionInput = {
  providerId: 'provider-1',
  externalTransactionId: 'external-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '20.00', currency: 'BRL' },
};

function persistedTransaction(
  wallet: WalletOrmEntity,
  overrides: Partial<WagerTransactionOrmEntity> = {},
): WagerTransactionOrmEntity {
  return {
    id: 'reference-id',
    providerId: 'provider-1',
    externalTransactionId: 'reference-external-id',
    idempotencyKey: 'reference-key',
    payloadHash: 'a'.repeat(64),
    wallet,
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    moneyAmount: '20.00',
    moneyCurrency: 'BRL',
    referenceExternalTransactionId: null,
    referenceTransaction: null,
    reversals: [],
    status: WagerTransactionStatus.Processed,
    failureCode: null,
    processedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    referenceAttempts: 0,
    referenceNextAttemptAt: null,
    idempotencyResponse: null,
    ledgerEntries: [],
    ...overrides,
  };
}

function setup(options?: {
  balance?: string;
  reference?: WagerTransactionOrmEntity | null;
  priorReversal?: WagerTransactionOrmEntity | null;
  priorExternalTransaction?: WagerTransactionOrmEntity | null;
  pendingTransactions?: WagerTransactionOrmEntity[];
}) {
  const wallet: WalletOrmEntity = {
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balanceAmount: options?.balance ?? '100.00',
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    wagerTransactions: [],
    ledgerEntries: [],
  };
  const reference = options?.reference ?? null;
  const priorReversal = options?.priorReversal ?? null;
  const priorExternalTransaction = options?.priorExternalTransaction ?? null;
  const pendingTransactions = options?.pendingTransactions ?? [];
  const persisted: object[] = [];
  const findOne = vi.fn(async (entity: unknown, where: unknown) => {
    if (entity === WalletOrmEntity) {
      return wallet;
    }
    if (entity === WagerTransactionOrmEntity) {
      const filter = where as Record<string, unknown>;
      if (filter.id) {
        return (
          pendingTransactions.find(
            (transaction) => transaction.id === filter.id,
          ) ?? null
        );
      }
      if (filter.externalTransactionId === 'reference-external-id') {
        return reference;
      }
      if (filter.externalTransactionId === 'external-1') {
        return priorExternalTransaction;
      }
      if (filter.referenceTransaction || filter.referenceTransactionId) {
        return priorReversal;
      }
      return null;
    }
    return null;
  });
  const manager = {
    findOne,
    find: vi.fn(async (entity: unknown) =>
      entity === WagerTransactionOrmEntity ? pendingTransactions : [],
    ),
    getConnection: () => ({
      execute: vi.fn(async () => undefined),
    }),
    transactional: vi.fn(
      async <Result>(callback: (em: EntityManager) => Promise<Result>) =>
        callback(manager as unknown as EntityManager),
    ),
    persist: vi.fn((entity: object) => {
      persisted.push(entity);
    }),
    flush: vi.fn(async () => undefined),
  } as unknown as EntityManager;

  return { wallet, persisted, findOne, manager };
}

function execute(
  manager: EntityManager,
  input: ProcessWagerTransactionInput = baseInput,
) {
  return new MikroOrmWagerTransactionProcessor().process(
    input,
    'provider-1:external-1',
    'b'.repeat(64),
    manager,
  );
}

describe('WagerTransactionProcessor business rules', () => {
  it('debits a BET and records exactly one balanced DEBIT ledger entry', async () => {
    const state = setup();
    const result = await execute(state.manager);
    const entries = state.persisted.filter(
      (entity) => entity instanceof WalletLedgerEntryOrmEntity,
    );

    expect(result.response.status).toBe(WagerTransactionStatus.Processed);
    expect(result.response.balance).toEqual({
      amount: '80.00',
      currency: 'BRL',
    });
    expect(state.wallet.balanceAmount).toBe('80.00');
    expect(state.wallet.version).toBe(2);
    expect(entries).toHaveLength(1);
    expect((entries[0] as WalletLedgerEntryOrmEntity).direction).toBe('DEBIT');
    expect((entries[0] as WalletLedgerEntryOrmEntity).balanceAfterAmount).toBe(
      '80.00',
    );
  });

  it('credits a WIN and records one CREDIT ledger entry', async () => {
    const state = setup({ balance: '80.00' });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Win,
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Processed);
    expect(result.response.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(
      state.persisted.filter(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toHaveLength(1);
    expect(
      state.persisted.filter(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      )[0],
    ).toMatchObject({ direction: 'CREDIT' });
  });

  it('allows a WIN to reference a processed BET in the same round', async () => {
    const state = setup({
      reference: persistedTransaction(setup().wallet, {
        externalTransactionId: 'reference-external-id',
      }),
    });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Processed);
    expect(
      state.persisted.find(
        (entity) => entity instanceof WagerTransactionOrmEntity,
      ),
    ).toMatchObject({ referenceTransaction: { id: 'reference-id' } });
  });

  it('records LOSS as processed without changing the wallet or adding a ledger entry', async () => {
    const state = setup();
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Loss,
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Processed);
    expect(result.response.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(state.wallet.version).toBe(1);
    expect(
      state.persisted.some(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toBe(false);
    expect(
      state.persisted.filter(
        (entity) => entity instanceof OutboxMessageOrmEntity,
      ),
    ).toHaveLength(1);
    expect(
      state.persisted.find(
        (entity) =>
          entity instanceof OutboxMessageOrmEntity &&
          entity.eventType === 'WagerTransactionProcessed',
      ),
    ).toBeDefined();
    expect(
      state.persisted.some(
        (entity) =>
          entity instanceof OutboxMessageOrmEntity &&
          entity.eventType === 'WalletBalanceChanged',
      ),
    ).toBe(false);
  });

  it('rejects an overdrawn BET with the business failure code and no ledger', async () => {
    const state = setup();
    const result = await execute(state.manager, {
      ...baseInput,
      money: { amount: '100.01', currency: 'BRL' },
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Rejected);
    expect(
      state.persisted.find(
        (entity) => entity instanceof WagerTransactionOrmEntity,
      ),
    ).toMatchObject({ failureCode: FailureCode.InsufficientBalance });
    expect(state.wallet.balanceAmount).toBe('100.00');
    expect(
      state.persisted.some(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toBe(false);
    expect(
      state.persisted.filter(
        (entity) => entity instanceof OutboxMessageOrmEntity,
      ),
    ).toHaveLength(1);
    expect(
      state.persisted.find(
        (entity) => entity instanceof OutboxMessageOrmEntity,
      ),
    ).toMatchObject({ eventType: 'WagerTransactionRejected' });
  });

  it('persists a currency mismatch as a rejected transaction with the wallet balance', async () => {
    const state = setup();
    const result = await execute(state.manager, {
      ...baseInput,
      money: { amount: '20.00', currency: 'USD' },
    });
    const transaction = state.persisted.find(
      (entity) => entity instanceof WagerTransactionOrmEntity,
    );

    expect(result.response.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.response.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(transaction).toMatchObject({
      moneyCurrency: 'USD',
      failureCode: FailureCode.CurrencyMismatch,
    });
    expect(state.wallet.balanceAmount).toBe('100.00');
  });

  it('does not apply a second transaction for the same provider external id', async () => {
    const prior = persistedTransaction(setup().wallet, {
      externalTransactionId: 'external-1',
    });
    const state = setup({ priorExternalTransaction: prior });

    await expect(execute(state.manager)).rejects.toMatchObject({
      code: 'DUPLICATE_EXTERNAL_TRANSACTION',
      statusCode: 409,
    });
    expect(state.persisted).toHaveLength(0);
    expect(state.wallet.balanceAmount).toBe('100.00');
  });

  it('refunds a processed BET exactly once', async () => {
    const wallet = setup({ balance: '80.00' }).wallet;
    const reference = persistedTransaction(wallet);
    const state = setup({ balance: '80.00', reference });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Processed);
    expect(result.response.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(
      state.persisted.find(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toMatchObject({ direction: 'CREDIT' });
  });

  it('rolls back a processed BET with an opposite-direction credit', async () => {
    const reference = persistedTransaction(setup({ balance: '80.00' }).wallet);
    const state = setup({ balance: '80.00', reference });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Processed);
    expect(result.response.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(
      state.persisted.find(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toMatchObject({ direction: 'CREDIT' });
  });

  it('rolls back a processed WIN with an opposite-direction debit', async () => {
    const reference = persistedTransaction(setup().wallet, {
      kind: WagerTransactionKind.Win,
    });
    const state = setup({ reference });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Processed);
    expect(result.response.balance).toEqual({
      amount: '80.00',
      currency: 'BRL',
    });
    expect(
      state.persisted.find(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toMatchObject({ direction: 'DEBIT' });
  });

  it('rolls back a processed REFUND with an opposite-direction debit', async () => {
    const reference = persistedTransaction(setup().wallet, {
      kind: WagerTransactionKind.Refund,
    });
    const state = setup({ reference });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Processed);
    expect(result.response.balance).toEqual({
      amount: '80.00',
      currency: 'BRL',
    });
    expect(
      state.persisted.find(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toMatchObject({ direction: 'DEBIT' });
  });

  it('rejects a ROLLBACK referencing a LOSS', async () => {
    const reference = persistedTransaction(setup().wallet, {
      kind: WagerTransactionKind.Loss,
    });
    const state = setup({ reference });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Rejected);
    expect(
      state.persisted.find(
        (entity) => entity instanceof WagerTransactionOrmEntity,
      ),
    ).toMatchObject({
      failureCode: FailureCode.InvalidReference,
      referenceTransaction: { id: 'reference-id' },
    });
    expect(
      state.persisted.some(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toBe(false);
  });

  it('rejects reversals that would overdraw with a distinct failure code', async () => {
    const reference = persistedTransaction(setup().wallet, {
      kind: WagerTransactionKind.Win,
      moneyAmount: '120.00',
    });
    const state = setup({ balance: '100.00', reference });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Rollback,
      money: { amount: '120.00', currency: 'BRL' },
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Rejected);
    expect(
      state.persisted.find(
        (entity) => entity instanceof WagerTransactionOrmEntity,
      ),
    ).toMatchObject({ failureCode: FailureCode.ReversalWouldOverdraw });
    expect(state.wallet.balanceAmount).toBe('100.00');
    expect(
      state.persisted.some(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toBe(false);
  });

  it('keeps a refund pending when its reference has not arrived', async () => {
    const state = setup();
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(result.response.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(
      state.persisted.find(
        (entity) => entity instanceof WagerTransactionOrmEntity,
      ),
    ).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      referenceAttempts: 0,
      referenceNextAttemptAt: expect.any(Date),
    });
    expect(
      state.persisted.some(
        (entity) => entity instanceof OutboxMessageOrmEntity,
      ),
    ).toBe(true);
    expect(
      state.persisted.some(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toBe(false);
  });

  it('reschedules a due missing reference with exponential backoff', async () => {
    const wallet = setup().wallet;
    const pending = persistedTransaction(wallet, {
      id: 'pending-refund',
      externalTransactionId: 'pending-refund-external',
      idempotencyKey: 'pending-refund-key',
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.PendingReference,
      referenceExternalTransactionId: 'reference-external-id',
      referenceTransaction: null,
      referenceAttempts: 0,
      referenceNextAttemptAt: new Date('2026-01-01T00:00:01.000Z'),
      idempotencyResponse: {
        transactionId: 'pending-refund',
        status: WagerTransactionStatus.PendingReference,
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      },
    });
    const state = setup({ pendingTransactions: [pending] });
    const now = new Date('2026-01-01T00:00:01.000Z');

    const processed =
      await new MikroOrmWagerTransactionProcessor().reprocessPendingReferences(
        state.manager,
        now,
        10,
      );

    expect(processed).toBe(1);
    expect(pending.referenceAttempts).toBe(1);
    expect(pending.referenceNextAttemptAt).toEqual(
      new Date('2026-01-01T00:00:03.000Z'),
    );
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
  });

  it('processes a pending refund when the referenced BET arrives', async () => {
    const wallet = setup({ balance: '80.00' }).wallet;
    const reference = persistedTransaction(wallet);
    const pending = persistedTransaction(wallet, {
      id: 'pending-refund',
      externalTransactionId: 'pending-refund-external',
      idempotencyKey: 'pending-refund-key',
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.PendingReference,
      referenceExternalTransactionId: 'reference-external-id',
      referenceAttempts: 0,
      referenceNextAttemptAt: new Date('2026-01-01T00:00:01.000Z'),
      idempotencyResponse: {
        transactionId: 'pending-refund',
        status: WagerTransactionStatus.PendingReference,
        balance: { amount: '80.00', currency: 'BRL' },
        idempotentReplay: false,
      },
    });
    const state = setup({
      balance: '80.00',
      reference,
      pendingTransactions: [pending],
    });

    await new MikroOrmWagerTransactionProcessor().reprocessPendingReferences(
      state.manager,
      new Date('2026-01-01T00:00:01.000Z'),
      10,
    );

    expect(pending.status).toBe(WagerTransactionStatus.Processed);
    expect(pending.referenceTransaction).toBe(reference);
    expect(pending.referenceNextAttemptAt).toBeNull();
    expect(pending.idempotencyResponse).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(state.wallet.balanceAmount).toBe('100.00');
    expect(
      state.persisted.some(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toBe(true);
  });

  it('rejects a pending reversal with REFERENCE_NOT_FOUND after eight retries', async () => {
    const wallet = setup().wallet;
    const pending = persistedTransaction(wallet, {
      id: 'pending-refund',
      externalTransactionId: 'pending-refund-external',
      idempotencyKey: 'pending-refund-key',
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.PendingReference,
      referenceExternalTransactionId: 'reference-external-id',
      referenceTransaction: null,
      referenceAttempts: 7,
      referenceNextAttemptAt: new Date('2026-01-01T00:00:01.000Z'),
      idempotencyResponse: {
        transactionId: 'pending-refund',
        status: WagerTransactionStatus.PendingReference,
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      },
    });
    const state = setup({ pendingTransactions: [pending] });

    const processed =
      await new MikroOrmWagerTransactionProcessor().reprocessPendingReferences(
        state.manager,
        new Date('2026-01-01T00:00:01.000Z'),
        10,
      );

    expect(processed).toBe(1);
    expect(pending.referenceAttempts).toBe(8);
    expect(pending.status).toBe(WagerTransactionStatus.Rejected);
    expect(pending.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(pending.idempotencyResponse).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      idempotentReplay: false,
    });
    expect(
      state.persisted.some(
        (entity) => entity instanceof OutboxMessageOrmEntity,
      ),
    ).toBe(true);
  });

  it.each([
    ['different provider', { providerId: 'other-provider' }],
    ['different player', { playerId: 'other-player' }],
    [
      'different wallet',
      {
        wallet: {
          id: 'other-wallet',
          playerId: 'player-1',
          currency: 'BRL',
          balanceAmount: '100.00',
          version: 1,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          wagerTransactions: [],
          ledgerEntries: [],
        },
      },
    ],
    ['different round', { roundId: 'other-round' }],
    ['different currency', { moneyCurrency: 'USD' }],
    ['different amount', { moneyAmount: '19.99' }],
    ['unprocessed reference', { status: WagerTransactionStatus.Pending }],
    ['unsupported kind', { kind: WagerTransactionKind.Loss }],
  ])('rejects a refund with a %s reference', async (_case, overrides) => {
    const reference = persistedTransaction(setup().wallet, overrides);
    const state = setup({ reference });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Rejected);
    expect(
      state.persisted.find(
        (entity) => entity instanceof WagerTransactionOrmEntity,
      ),
    ).toMatchObject({ failureCode: FailureCode.InvalidReference });
    expect(
      state.persisted.some(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toBe(false);
  });

  it('rejects a second processed reversal of the same type', async () => {
    const wallet = setup().wallet;
    const reference = persistedTransaction(wallet);
    const priorReversal = persistedTransaction(wallet, {
      id: 'prior-refund',
      externalTransactionId: 'prior-refund-external',
      kind: WagerTransactionKind.Refund,
      referenceTransaction: reference,
    });
    const state = setup({ reference, priorReversal });
    const result = await execute(state.manager, {
      ...baseInput,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'reference-external-id',
    });

    expect(result.response.status).toBe(WagerTransactionStatus.Rejected);
    expect(
      state.persisted.find(
        (entity) => entity instanceof WagerTransactionOrmEntity,
      ),
    ).toMatchObject({
      failureCode: FailureCode.DuplicateReversal,
      referenceTransaction: { id: 'reference-id' },
    });
    expect(
      state.persisted.some(
        (entity) => entity instanceof WalletLedgerEntryOrmEntity,
      ),
    ).toBe(false);
  });

  it('locks the wallet row before applying a financial operation', async () => {
    const state = setup();
    await execute(state.manager);

    expect(state.findOne).toHaveBeenCalledWith(
      WalletOrmEntity,
      { id: 'wallet-1' },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
  });
});
