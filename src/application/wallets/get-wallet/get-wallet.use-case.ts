import { EntityManager } from '@mikro-orm/postgresql';
import { AppError } from '../../../shared/errors/app.error.js';
import { WalletResponse } from '../create-wallet/create-wallet.use-case.js';
import { WalletOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet.orm-entity.js';

export class GetWalletUseCase {
  constructor(private readonly entityManager: EntityManager) {}

  async execute(walletId: string): Promise<WalletResponse> {
    const wallet = await this.entityManager
      .fork()
      .findOne(WalletOrmEntity, { id: walletId });
    if (!wallet) {
      throw new AppError('Wallet was not found.', 'WALLET_NOT_FOUND', 404);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: wallet.balanceAmount, currency: wallet.currency },
      version: wallet.version,
    };
  }
}
