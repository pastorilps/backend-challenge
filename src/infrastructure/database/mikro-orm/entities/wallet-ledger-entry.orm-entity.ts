import type { WagerTransactionOrmEntity } from './wager-transaction.orm-entity.js';
import type { WalletOrmEntity } from './wallet.orm-entity.js';

export class WalletLedgerEntryOrmEntity {
  declare id: string;
  declare wallet: WalletOrmEntity;
  declare transaction: WagerTransactionOrmEntity;
  declare direction: string;
  declare amount: string;
  declare currency: string;
  declare balanceBeforeAmount: string;
  declare balanceAfterAmount: string;
  declare createdAt: Date;
}
