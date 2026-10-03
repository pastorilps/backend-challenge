import { WalletReconciliationMetrics } from '../wallets/reconcile-wallet/reconcile-wallet.use-case.js';

export interface ApplicationMetrics extends WalletReconciliationMetrics {
  recordTransactionStatus(status: string): void;
  incrementDuplicateCount(): void;
  incrementRetry(source: 'sqs' | 'outbox'): void;
  incrementDeadLetterCount(): void;
  incrementLockConflictCount(): void;
  observeProcessingLatency(milliseconds: number): void;
  observeOutboxLag(milliseconds: number): void;
}
