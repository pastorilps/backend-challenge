import { EntityManager } from '@mikro-orm/postgresql';
import { AppError } from '../../../shared/errors/app.error.js';
import { WagerTransactionOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wager-transaction.orm-entity.js';

export interface WagerTransactionDetails {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId: string | null;
  status: string;
  failureCode: string | null;
  createdAt: string;
  processedAt: string | null;
}

export class GetWagerTransactionUseCase {
  constructor(private readonly entityManager: EntityManager) {}

  byId(transactionId: string): Promise<WagerTransactionDetails> {
    return this.findOne({ id: transactionId });
  }

  byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionDetails> {
    return this.findOne({ providerId, externalTransactionId });
  }

  private async findOne(
    where: Partial<
      Pick<
        WagerTransactionOrmEntity,
        'id' | 'providerId' | 'externalTransactionId'
      >
    >,
  ): Promise<WagerTransactionDetails> {
    const transaction = await this.entityManager
      .fork()
      .findOne(WagerTransactionOrmEntity, where, { populate: ['wallet'] });
    if (!transaction) {
      throw new AppError(
        'Wager transaction was not found.',
        'WAGER_TRANSACTION_NOT_FOUND',
        404,
      );
    }

    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.wallet.id,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: {
        amount: transaction.moneyAmount,
        currency: transaction.moneyCurrency,
      },
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      createdAt: transaction.createdAt.toISOString(),
      processedAt: transaction.processedAt?.toISOString() ?? null,
    };
  }
}
