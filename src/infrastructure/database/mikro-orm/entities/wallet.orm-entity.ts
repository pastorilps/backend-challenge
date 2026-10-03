import type { WagerTransactionOrmEntity } from './wager-transaction.orm-entity.js';
import type { WalletLedgerEntryOrmEntity } from './wallet-ledger-entry.orm-entity.js';

export class WalletOrmEntity {
  declare id: string;
  declare playerId: string;
  declare currency: string;
  declare balanceAmount: string;
  declare version: number;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare wagerTransactions: WagerTransactionOrmEntity[];
  declare ledgerEntries: WalletLedgerEntryOrmEntity[];
}
