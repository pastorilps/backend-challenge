import { WalletLedgerEntry } from '../entities/wallet-ledger-entry.js';

export interface WalletLedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export abstract class WalletLedgerRepository {
  abstract append(entry: WalletLedgerEntry): Promise<void>;
  abstract findByWalletId(
    walletId: string,
    options: { cursor?: string; limit: number },
  ): Promise<WalletLedgerPage>;
  abstract findByWalletIdInChronologicalOrder(
    walletId: string,
  ): Promise<WalletLedgerEntry[]>;
}
