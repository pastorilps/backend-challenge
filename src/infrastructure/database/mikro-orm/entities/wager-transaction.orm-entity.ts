import type { WalletLedgerEntryOrmEntity } from './wallet-ledger-entry.orm-entity.js';
import type { WalletOrmEntity } from './wallet.orm-entity.js';
import type { WagerTransactionResponse } from '../../../../application/wagering/process-wager-transaction/idempotency.types.js';

export class WagerTransactionOrmEntity {
  declare id: string;
  declare providerId: string;
  declare externalTransactionId: string;
  declare idempotencyKey: string;
  declare payloadHash: string;
  declare wallet: WalletOrmEntity;
  declare playerId: string;
  declare roundId: string | null;
  declare gameId: string | null;
  declare kind: string;
  declare moneyAmount: string;
  declare moneyCurrency: string;
  declare referenceExternalTransactionId: string | null;
  declare referenceTransaction: WagerTransactionOrmEntity | null;
  declare reversals: WagerTransactionOrmEntity[];
  declare status: string;
  declare failureCode: string | null;
  declare processedAt: Date | null;
  declare createdAt: Date;
  declare referenceAttempts: number;
  declare referenceNextAttemptAt: Date | null;
  declare idempotencyResponse: WagerTransactionResponse | null;
  declare ledgerEntries: WalletLedgerEntryOrmEntity[];
}
