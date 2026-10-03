import { Counter, TracerService } from '@nestjs/observe';
import { WalletReconciliationMetrics } from '../../../application/wallets/reconcile-wallet/reconcile-wallet.use-case.js';

export class AppMetrics implements WalletReconciliationMetrics {
  private readonly walletReconciliationMismatches: Counter;

  constructor(tracer: TracerService) {
    this.walletReconciliationMismatches = tracer.counter(
      'wallet_reconciliation_mismatches_total',
      {
        description: 'Wallet reconciliations that found a ledger mismatch.',
      },
    );
  }

  incrementMismatchCount(): void {
    this.walletReconciliationMismatches.increment();
  }
}
