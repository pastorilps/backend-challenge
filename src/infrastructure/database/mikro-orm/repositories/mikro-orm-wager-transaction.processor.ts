import { EntityManager, LockMode } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../../shared/errors/app.error.js';
import { EventContext } from '../../../../shared/events/integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../../shared/events/wager-transaction.events.js';
import { OutboxMessage } from '../../../../domain/outbox/entities/outbox-message.js';
import { WalletLedgerEntry } from '../../../../domain/ledger/entities/wallet-ledger-entry.js';
import { LedgerDirection } from '../../../../domain/ledger/enums/ledger-direction.js';
import { WagerTransaction } from '../../../../domain/wagering/entities/wager-transaction.js';
import { FailureCode } from '../../../../domain/wagering/enums/failure-code.js';
import { WagerTransactionKind } from '../../../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../../domain/wagering/enums/wager-transaction-status.js';
import { IdempotencyKey } from '../../../../domain/wagering/value-objects/idempotency-key.js';
import { InsufficientBalanceError } from '../../../../domain/wallet/errors/insufficient-balance.error.js';
import { Money } from '../../../../domain/wallet/value-objects/money.js';
import { Wallet } from '../../../../domain/wallet/entities/wallet.js';
import {
  PendingReferenceReprocessor,
  WagerTransactionProcessor,
} from '../../../../application/wagering/process-wager-transaction/wager-transaction-processor.js';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity.js';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../entities/wallet.orm-entity.js';
import {
  IdempotentOperationResult,
  ProcessWagerTransactionInput,
} from '../../../../application/wagering/process-wager-transaction/idempotency.types.js';

const REFERENCE_RETRY_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000,
] as const;

export class MikroOrmWagerTransactionProcessor
  extends WagerTransactionProcessor
  implements PendingReferenceReprocessor
{
  async reprocessPendingReferences(
    entityManager: EntityManager,
    now: Date,
    limit: number,
  ): Promise<number> {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new RangeError('Reference retry time must be a valid date.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(
        'Reference retry batch size must be a positive integer.',
      );
    }

    const dueTransactions = await entityManager.find(
      WagerTransactionOrmEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        referenceNextAttemptAt: { $lte: now },
      },
      {
        orderBy: { referenceNextAttemptAt: 'ASC' },
        limit,
      },
    );

    for (const candidate of dueTransactions) {
      await entityManager.transactional(async (transactionManager) => {
        const walletEntity = await transactionManager.findOne(
          WalletOrmEntity,
          { id: candidate.wallet.id },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!walletEntity) {
          throw new AppError(
            `Wallet ${candidate.wallet.id} for pending transaction ${candidate.id} was not found.`,
            'WALLET_NOT_FOUND',
            404,
          );
        }

        const transactionEntity = await transactionManager.findOne(
          WagerTransactionOrmEntity,
          { id: candidate.id },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (
          !transactionEntity ||
          transactionEntity.status !==
            WagerTransactionStatus.PendingReference ||
          !transactionEntity.referenceNextAttemptAt ||
          transactionEntity.referenceNextAttemptAt > now
        ) {
          return;
        }

        const transaction = this.toDomainTransaction(transactionEntity);
        const referenceEntity = await transactionManager.findOne(
          WagerTransactionOrmEntity,
          {
            providerId: transaction.providerId,
            externalTransactionId: transaction.referenceExternalTransactionId,
          },
        );

        if (!referenceEntity) {
          const attempts = transactionEntity.referenceAttempts + 1;
          transactionEntity.referenceAttempts = attempts;
          if (attempts >= REFERENCE_RETRY_DELAYS_MS.length) {
            transaction.reject(FailureCode.ReferenceNotFound);
            this.updateTransactionEntity(transaction, transactionEntity);
            transactionEntity.referenceNextAttemptAt = null;
            this.updateIdempotencyResponse(transactionEntity, transaction);
            transactionManager.persist(transactionEntity);
            this.persistOutbox(
              transactionManager,
              OutboxMessage.enqueue(
                WagerTransactionRejected.from(transaction, {
                  correlationId: randomUUID(),
                  causationId: transaction.id,
                  occurredAt: now,
                }),
              ),
            );
          } else {
            transactionEntity.referenceNextAttemptAt = new Date(
              now.getTime() + REFERENCE_RETRY_DELAYS_MS[attempts],
            );
            transactionManager.persist(transactionEntity);
          }
          await transactionManager.flush();
          return;
        }

        const reference = this.toDomainTransaction(referenceEntity);
        try {
          transaction.assertValidReference(reference);
        } catch (error) {
          if (!(error instanceof AppError)) {
            throw error;
          }
          transaction.reject(FailureCode.InvalidReference);
          this.updateTransactionEntity(transaction, transactionEntity);
          transactionEntity.referenceTransaction = referenceEntity;
          transactionEntity.referenceNextAttemptAt = null;
          this.updateIdempotencyResponse(transactionEntity, transaction);
          transactionManager.persist(transactionEntity);
          this.persistOutbox(
            transactionManager,
            OutboxMessage.enqueue(
              WagerTransactionRejected.from(transaction, {
                correlationId: randomUUID(),
                causationId: transaction.id,
                occurredAt: now,
              }),
            ),
          );
          await transactionManager.flush();
          return;
        }

        const existingReversal = await transactionManager.findOne(
          WagerTransactionOrmEntity,
          {
            referenceTransaction: referenceEntity,
            kind: transaction.kind,
            status: WagerTransactionStatus.Processed,
          },
        );
        if (existingReversal) {
          transaction.reject(FailureCode.DuplicateReversal);
          this.updateTransactionEntity(transaction, transactionEntity);
          transactionEntity.referenceTransaction = referenceEntity;
          transactionEntity.referenceNextAttemptAt = null;
          this.updateIdempotencyResponse(transactionEntity, transaction);
          transactionManager.persist(transactionEntity);
          this.persistOutbox(
            transactionManager,
            OutboxMessage.enqueue(
              WagerTransactionRejected.from(transaction, {
                correlationId: randomUUID(),
                causationId: transaction.id,
                occurredAt: now,
              }),
            ),
          );
          await transactionManager.flush();
          return;
        }

        const wallet = this.toWallet(walletEntity);
        let ledgerEntry: WalletLedgerEntry;
        try {
          const direction = transaction.ledgerDirectionFor(reference);
          ledgerEntry =
            direction === LedgerDirection.Debit
              ? wallet.debit({
                  transactionId: transaction.id,
                  money: transaction.money,
                  at: now,
                })
              : wallet.credit({
                  transactionId: transaction.id,
                  money: transaction.money,
                  at: now,
                });
        } catch (error) {
          if (!(error instanceof InsufficientBalanceError)) {
            throw error;
          }
          transaction.reject(FailureCode.ReversalWouldOverdraw);
          this.updateTransactionEntity(transaction, transactionEntity);
          transactionEntity.referenceTransaction = referenceEntity;
          transactionEntity.referenceNextAttemptAt = null;
          this.updateIdempotencyResponse(transactionEntity, transaction);
          transactionManager.persist(transactionEntity);
          this.persistOutbox(
            transactionManager,
            OutboxMessage.enqueue(
              WagerTransactionRejected.from(transaction, {
                correlationId: randomUUID(),
                causationId: transaction.id,
                occurredAt: now,
              }),
            ),
          );
          await transactionManager.flush();
          return;
        }

        transaction.markProcessed(reference.id, now);
        transactionEntity.referenceTransaction = referenceEntity;
        transactionEntity.referenceNextAttemptAt = null;
        this.updateTransactionEntity(transaction, transactionEntity);
        this.updateWalletEntity(wallet, walletEntity);
        this.updateIdempotencyResponse(transactionEntity, transaction, wallet);
        transactionManager.persist(transactionEntity);
        transactionManager.persist(walletEntity);
        transactionManager.persist(this.toLedgerEntity(ledgerEntry));
        const context: EventContext = {
          correlationId: randomUUID(),
          causationId: transaction.id,
          occurredAt: now,
        };
        this.persistOutbox(
          transactionManager,
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(transaction, context),
          ),
        );
        this.persistOutbox(
          transactionManager,
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, ledgerEntry, context),
          ),
        );
        await transactionManager.flush();
      });
    }

    return dueTransactions.length;
  }

  override async process(
    input: ProcessWagerTransactionInput,
    idempotencyKey: string,
    payloadHash: string,
    transactionManager: EntityManager,
  ): Promise<IdempotentOperationResult> {
    await transactionManager
      .getConnection()
      .execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `external:${input.providerId}:${input.externalTransactionId}`,
      ]);

    const walletEntity = await transactionManager.findOne(
      WalletOrmEntity,
      { id: input.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!walletEntity) {
      throw new AppError('Wallet was not found.', 'WALLET_NOT_FOUND', 404);
    }

    const existingExternalTransaction = await transactionManager.findOne(
      WagerTransactionOrmEntity,
      {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      },
    );
    if (existingExternalTransaction) {
      throw new AppError(
        'Provider transaction identifier has already been used.',
        'DUPLICATE_EXTERNAL_TRANSACTION',
        409,
      );
    }

    const now = new Date();
    const transaction = WagerTransaction.create({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: IdempotencyKey.from(idempotencyKey),
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: Money.from(input.money),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });
    const transactionEntity = this.toTransactionEntity(
      transaction,
      walletEntity,
    );
    const wallet = this.toWallet(walletEntity);

    if (wallet.playerId !== input.playerId) {
      transaction.reject(FailureCode.InvalidTransaction);
      return this.persistRejected(
        transaction,
        transactionEntity,
        walletEntity,
        wallet,
        transactionManager,
      );
    }
    if (wallet.currency !== transaction.money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch);
      return this.persistRejected(
        transaction,
        transactionEntity,
        walletEntity,
        wallet,
        transactionManager,
      );
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId) {
      const referenceEntity = await transactionManager.findOne(
        WagerTransactionOrmEntity,
        {
          providerId: transaction.providerId,
          externalTransactionId: transaction.referenceExternalTransactionId,
        },
      );

      if (!referenceEntity && transaction.requiresReference()) {
        transaction.markPendingReference();
        return this.persistPendingReference(
          transaction,
          transactionEntity,
          walletEntity,
          wallet,
          transactionManager,
          now,
        );
      }

      if (!referenceEntity) {
        transaction.reject(FailureCode.InvalidReference);
        return this.persistRejected(
          transaction,
          transactionEntity,
          walletEntity,
          wallet,
          transactionManager,
        );
      }

      transactionEntity.referenceTransaction = referenceEntity;
      reference = this.toDomainTransaction(referenceEntity);
      try {
        this.assertReferenceAllowed(transaction, reference);
      } catch (error) {
        if (!(error instanceof AppError)) {
          throw error;
        }
        transaction.reject(FailureCode.InvalidReference);
        return this.persistRejected(
          transaction,
          transactionEntity,
          walletEntity,
          wallet,
          transactionManager,
        );
      }

      if (transaction.requiresReference()) {
        const existingReversal = await transactionManager.findOne(
          WagerTransactionOrmEntity,
          {
            referenceTransaction: referenceEntity,
            kind: transaction.kind,
            status: WagerTransactionStatus.Processed,
          },
        );
        if (existingReversal) {
          transaction.reject(FailureCode.DuplicateReversal);
          return this.persistRejected(
            transaction,
            transactionEntity,
            walletEntity,
            wallet,
            transactionManager,
          );
        }
      }
    }

    let ledgerEntry: WalletLedgerEntry | undefined;
    try {
      if (transaction.affectsBalance()) {
        const direction = transaction.ledgerDirectionFor(reference);
        ledgerEntry =
          direction === LedgerDirection.Debit
            ? wallet.debit({
                transactionId: transaction.id,
                money: transaction.money,
                at: now,
              })
            : wallet.credit({
                transactionId: transaction.id,
                money: transaction.money,
                at: now,
              });
      }
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        transaction.reject(
          transaction.kind === WagerTransactionKind.Rollback
            ? FailureCode.ReversalWouldOverdraw
            : FailureCode.InsufficientBalance,
        );
        return this.persistRejected(
          transaction,
          transactionEntity,
          walletEntity,
          wallet,
          transactionManager,
        );
      }
      if (error instanceof AppError) {
        transaction.reject(FailureCode.InvalidReference);
        return this.persistRejected(
          transaction,
          transactionEntity,
          walletEntity,
          wallet,
          transactionManager,
        );
      }
      throw error;
    }

    transaction.markProcessed(reference?.id, now);
    this.updateTransactionEntity(transaction, transactionEntity);
    const response = {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false as const,
    };

    transactionManager.persist(transactionEntity);
    if (ledgerEntry) {
      this.updateWalletEntity(wallet, walletEntity);
      transactionManager.persist(walletEntity);
      transactionManager.persist(this.toLedgerEntity(ledgerEntry));
    }

    const context: EventContext = {
      correlationId: randomUUID(),
      causationId: transaction.id,
      occurredAt: now,
    };
    this.persistOutbox(
      transactionManager,
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(transaction, context),
      ),
    );
    if (ledgerEntry) {
      this.persistOutbox(
        transactionManager,
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, ledgerEntry, context),
        ),
      );
    }
    await transactionManager.flush();
    return { transaction: transactionEntity, response };
  }

  private async persistRejected(
    transaction: WagerTransaction,
    transactionEntity: WagerTransactionOrmEntity,
    walletEntity: WalletOrmEntity,
    wallet: Wallet,
    entityManager: EntityManager,
  ): Promise<IdempotentOperationResult> {
    this.updateTransactionEntity(transaction, transactionEntity);
    entityManager.persist(transactionEntity);
    this.persistOutbox(
      entityManager,
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(transaction, {
          correlationId: randomUUID(),
          causationId: transaction.id,
          occurredAt: new Date(),
        }),
      ),
    );
    await entityManager.flush();
    return {
      transaction: transactionEntity,
      response: {
        transactionId: transaction.id,
        status: transaction.status,
        balance:
          wallet.playerId === transaction.playerId
            ? wallet.balance.toJSON()
            : Money.from({
                amount: walletEntity.balanceAmount,
                currency: walletEntity.currency,
              }).toJSON(),
        ...(transaction.failureCode
          ? { failureCode: transaction.failureCode }
          : {}),
        idempotentReplay: false,
      },
    };
  }

  private async persistPendingReference(
    transaction: WagerTransaction,
    transactionEntity: WagerTransactionOrmEntity,
    walletEntity: WalletOrmEntity,
    wallet: Wallet,
    entityManager: EntityManager,
    now: Date,
  ): Promise<IdempotentOperationResult> {
    this.updateTransactionEntity(transaction, transactionEntity);
    transactionEntity.referenceAttempts = 0;
    transactionEntity.referenceNextAttemptAt = new Date(
      now.getTime() + REFERENCE_RETRY_DELAYS_MS[0],
    );
    entityManager.persist(transactionEntity);
    this.persistOutbox(
      entityManager,
      OutboxMessage.enqueue(
        WagerTransactionPendingReference.from(transaction, {
          correlationId: randomUUID(),
          causationId: transaction.id,
          occurredAt: now,
        }),
      ),
    );
    await entityManager.flush();
    return {
      transaction: transactionEntity,
      response: {
        transactionId: transaction.id,
        status: transaction.status,
        balance:
          wallet.playerId === transaction.playerId
            ? wallet.balance.toJSON()
            : Money.from({
                amount: walletEntity.balanceAmount,
                currency: walletEntity.currency,
              }).toJSON(),
        idempotentReplay: false,
      },
    };
  }

  private assertReferenceAllowed(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): void {
    if (transaction.requiresReference()) {
      transaction.assertValidReference(reference);
      return;
    }
    if (
      transaction.kind === WagerTransactionKind.Win &&
      (reference.status !== WagerTransactionStatus.Processed ||
        reference.kind !== WagerTransactionKind.Bet ||
        reference.providerId !== transaction.providerId ||
        reference.playerId !== transaction.playerId ||
        reference.walletId !== transaction.walletId ||
        reference.roundId !== transaction.roundId ||
        reference.money.currency !== transaction.money.currency)
    ) {
      throw new AppError(
        'WIN reference must be a processed BET in the same provider, player, wallet, currency and round.',
        'INVALID_REFERENCE',
        422,
      );
    }
  }

  private toWallet(entity: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balanceAmount,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  private toDomainTransaction(
    entity: WagerTransactionOrmEntity,
  ): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.wallet.id,
      playerId: entity.playerId,
      roundId: entity.roundId ?? '',
      gameId: entity.gameId ?? '',
      kind: entity.kind as WagerTransactionKind,
      money: Money.from({
        amount: entity.moneyAmount,
        currency: entity.moneyCurrency,
      }),
      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,
      createdAt: entity.createdAt,
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: entity.referenceTransaction?.id,
      failureCode: entity.failureCode as FailureCode | undefined,
      processedAt: entity.processedAt ?? undefined,
    });
  }

  private toTransactionEntity(
    transaction: WagerTransaction,
    wallet: WalletOrmEntity,
  ): WagerTransactionOrmEntity {
    const entity = new WagerTransactionOrmEntity();
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.wallet = wallet;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId || null;
    entity.gameId = transaction.gameId || null;
    entity.kind = transaction.kind;
    entity.moneyAmount = transaction.money.toString();
    entity.moneyCurrency = transaction.money.currency;
    entity.referenceExternalTransactionId =
      transaction.referenceExternalTransactionId ?? null;
    entity.referenceTransaction = null;
    entity.reversals = [];
    entity.status = transaction.status;
    entity.failureCode = transaction.failureCode ?? null;
    entity.processedAt = transaction.processedAt ?? null;
    entity.createdAt = transaction.createdAt;
    entity.referenceAttempts = 0;
    entity.referenceNextAttemptAt = null;
    entity.idempotencyResponse = null;
    entity.ledgerEntries = [];
    return entity;
  }

  private updateTransactionEntity(
    transaction: WagerTransaction,
    entity: WagerTransactionOrmEntity,
  ): void {
    entity.status = transaction.status;
    entity.failureCode = transaction.failureCode ?? null;
    entity.processedAt = transaction.processedAt ?? null;
  }

  private updateWalletEntity(wallet: Wallet, entity: WalletOrmEntity): void {
    entity.balanceAmount = wallet.balance.toString();
    entity.version = wallet.version;
    entity.updatedAt = wallet.updatedAt;
  }

  private updateIdempotencyResponse(
    entity: WagerTransactionOrmEntity,
    transaction: WagerTransaction,
    wallet?: Wallet,
  ): void {
    if (!entity.idempotencyResponse) {
      throw new Error(
        `Pending transaction ${transaction.id} has no persisted idempotency response.`,
      );
    }
    entity.idempotencyResponse = {
      ...entity.idempotencyResponse,
      status: transaction.status,
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : { failureCode: undefined }),
      balance:
        wallet?.balance.toJSON() ??
        (entity.idempotencyResponse.balance
          ? { ...entity.idempotencyResponse.balance }
          : null),
      idempotentReplay: false,
    };
  }

  private toLedgerEntity(entry: WalletLedgerEntry): WalletLedgerEntryOrmEntity {
    const entity = new WalletLedgerEntryOrmEntity();
    entity.id = entry.id;
    entity.wallet = { id: entry.walletId } as WalletOrmEntity;
    entity.transaction = {
      id: entry.transactionId,
    } as WagerTransactionOrmEntity;
    entity.direction = entry.direction;
    entity.amount = entry.money.toString();
    entity.currency = entry.money.currency;
    entity.balanceBeforeAmount = entry.balanceBefore.toString();
    entity.balanceAfterAmount = entry.balanceAfter.toString();
    entity.createdAt = entry.createdAt;
    return entity;
  }

  private persistOutbox(
    entityManager: EntityManager,
    message: OutboxMessage,
  ): void {
    const entity = new OutboxMessageOrmEntity();
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.payloadJson = structuredClone(message.payload);
    entity.occurredAt = message.occurredAt;
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt ?? null;
    entity.publishedAt = message.publishedAt ?? null;
    entity.status = 'PENDING';
    entityManager.persist(entity);
  }
}
