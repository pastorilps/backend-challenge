import { MikroORM } from '@mikro-orm/postgresql';
import { AppError } from '../../../shared/errors/app.error.js';
import { LedgerDirection } from '../../../domain/ledger/enums/ledger-direction.js';
import { WalletLedgerEntry } from '../../../domain/ledger/entities/wallet-ledger-entry.js';
import { WagerTransaction } from '../../../domain/wagering/entities/wager-transaction.js';
import { WagerTransactionKind } from '../../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/enums/wager-transaction-status.js';
import { Wallet } from '../../../domain/wallet/entities/wallet.js';
import {
  Money,
  MoneyProps,
} from '../../../domain/wallet/value-objects/money.js';
import { WagerTransactionOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet.orm-entity.js';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class CreateWalletUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(input: CreateWalletInput): Promise<WalletResponse> {
    const initialBalance = Money.from(input.initialBalance);
    if (initialBalance.currency !== 'BRL') {
      throw new AppError(
        'Only BRL wallets are supported.',
        'CURRENCY_MISMATCH',
        422,
      );
    }

    const wallet = Wallet.open({
      playerId: input.playerId,
      initialBalance,
    });
    const walletEntity = new WalletOrmEntity();
    walletEntity.id = wallet.id;
    walletEntity.playerId = wallet.playerId;
    walletEntity.currency = wallet.currency;
    walletEntity.balanceAmount = wallet.balance.toString();
    walletEntity.version = wallet.version;
    walletEntity.createdAt = wallet.createdAt;
    walletEntity.updatedAt = wallet.updatedAt;
    walletEntity.wagerTransactions = [];
    walletEntity.ledgerEntries = [];

    await this.orm.em.transactional(async (em) => {
      em.persist(walletEntity);

      if (initialBalance.isZero()) {
        return;
      }

      const now = wallet.createdAt;
      const opening = WagerTransaction.opening({
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
        createdAt: now,
      });
      opening.markProcessed(undefined, now);

      const transactionEntity = new WagerTransactionOrmEntity();
      transactionEntity.id = opening.id;
      transactionEntity.providerId = 'internal';
      transactionEntity.externalTransactionId = `opening:${wallet.id}`;
      transactionEntity.idempotencyKey = `opening:${wallet.id}`;
      transactionEntity.payloadHash = '0'.repeat(64);
      transactionEntity.wallet = walletEntity;
      transactionEntity.playerId = wallet.playerId;
      transactionEntity.roundId = null;
      transactionEntity.gameId = null;
      transactionEntity.kind = WagerTransactionKind.Opening;
      transactionEntity.moneyAmount = initialBalance.toString();
      transactionEntity.moneyCurrency = initialBalance.currency;
      transactionEntity.referenceExternalTransactionId = null;
      transactionEntity.referenceTransaction = null;
      transactionEntity.reversals = [];
      transactionEntity.status = WagerTransactionStatus.Processed;
      transactionEntity.failureCode = null;
      transactionEntity.processedAt = now;
      transactionEntity.referenceAttempts = 0;
      transactionEntity.referenceNextAttemptAt = null;
      transactionEntity.idempotencyResponse = null;
      transactionEntity.createdAt = now;
      transactionEntity.ledgerEntries = [];

      const ledgerEntry = WalletLedgerEntry.create({
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(initialBalance.currency),
        balanceAfter: initialBalance,
        createdAt: now,
      });
      const ledgerEntity = new WalletLedgerEntryOrmEntity();
      ledgerEntity.id = ledgerEntry.id;
      ledgerEntity.wallet = walletEntity;
      ledgerEntity.transaction = transactionEntity;
      ledgerEntity.direction = LedgerDirection.Credit;
      ledgerEntity.amount = initialBalance.toString();
      ledgerEntity.currency = initialBalance.currency;
      ledgerEntity.balanceBeforeAmount = ledgerEntry.balanceBefore.toString();
      ledgerEntity.balanceAfterAmount = ledgerEntry.balanceAfter.toString();
      ledgerEntity.createdAt = now;

      em.persist([transactionEntity, ledgerEntity]);
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
