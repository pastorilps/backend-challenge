import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors/app.error.js';
import { LedgerDirection } from '../../../domain/ledger/enums/ledger-direction.js';
import { Money } from '../../../domain/wallet/value-objects/money.js';
import { WalletLedgerEntryOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet.orm-entity.js';

export interface WalletReconciliationResult {
  walletId: string;
  storedBalance: ReturnType<Money['toJSON']>;
  calculatedBalance: ReturnType<Money['toJSON']>;
  difference: ReturnType<Money['toJSON']>;
  consistent: boolean;
  checkedEntries: number;
}

export interface WalletReconciliationMetrics {
  incrementMismatchCount(): void;
}

export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    private readonly entityManager: EntityManager,
    private readonly metrics: WalletReconciliationMetrics,
  ) {}

  execute(walletId: string): Promise<WalletReconciliationResult> {
    return this.entityManager.transactional(async (em) => {
      const wallet = await em.findOne(
        WalletOrmEntity,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!wallet) {
        throw new AppError('Wallet was not found.', 'WALLET_NOT_FOUND', 404);
      }

      const entries = await em.find(
        WalletLedgerEntryOrmEntity,
        { wallet: walletId },
        { orderBy: { createdAt: 'ASC', id: 'ASC' } },
      );
      const calculated = entries.reduce((balance, entry) => {
        const amount = Money.from({
          amount: entry.amount,
          currency: entry.currency,
        });
        return entry.direction === LedgerDirection.Credit
          ? balance.add(amount)
          : balance.subtract(amount);
      }, Money.zero(wallet.currency));
      const stored = Money.from({
        amount: wallet.balanceAmount,
        currency: wallet.currency,
      });
      const difference = stored.subtract(calculated);
      const result: WalletReconciliationResult = {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: entries.length,
      };

      if (!result.consistent) {
        this.metrics.incrementMismatchCount();
        this.logger.error(
          JSON.stringify({
            event: 'wallet_reconciliation_mismatch',
            correlationId: randomUUID(),
            messageId: null,
            transactionId: null,
            walletId,
            providerId: null,
            checkedEntries: entries.length,
          }),
        );
      }
      return result;
    });
  }
}
