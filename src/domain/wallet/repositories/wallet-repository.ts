import { Wallet } from '../entities/wallet.js';

export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | null>;
  abstract findByPlayerIdAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;
  abstract save(wallet: Wallet): Promise<void>;
}
