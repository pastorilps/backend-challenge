import { Counter, Summary, TracerService } from '@nestjs/observe';
import { ApplicationMetrics } from '../../../application/observability/application-metrics.js';

export class AppMetrics implements ApplicationMetrics {
  private readonly walletReconciliationMismatches: Counter;
  private readonly transactionsByStatus: Counter<'status'>;
  private readonly duplicates: Counter;
  private readonly retries: Counter<'source'>;
  private readonly deadLetters: Counter;
  private readonly lockConflicts: Counter;
  private readonly processingLatency: Summary;
  private readonly outboxLag: Summary;

  constructor(tracer: TracerService) {
    this.walletReconciliationMismatches = tracer.counter(
      'wallet_reconciliation_mismatches_total',
      {
        description: 'Wallet reconciliations that found a ledger mismatch.',
      },
    );
    this.transactionsByStatus = tracer.counter(
      'wager_transactions_total',
      {
        description: 'Wager transactions completed by final status.',
        labels: ['status'],
      },
    );
    this.duplicates = tracer.counter('wager_transaction_duplicates_total', {
      description: 'Duplicate wager submissions detected.',
    });
    this.retries = tracer.counter('messaging_retries_total', {
      description: 'Scheduled retries by messaging component.',
      labels: ['source'],
    });
    this.deadLetters = tracer.counter('sqs_messages_dead_lettered_total', {
      description: 'SQS messages sent to a dead-letter queue.',
    });
    this.lockConflicts = tracer.counter('database_lock_conflicts_total', {
      description: 'Database deadlocks and lock timeouts.',
    });
    this.processingLatency = tracer.summary(
      'wager_processing_latency_ms',
      { description: 'Time spent processing wager submissions in ms.' },
    );
    this.outboxLag = tracer.summary('outbox_lag_ms', {
      description: 'Age of integration events when published in ms.',
    });
  }

  incrementMismatchCount(): void {
    this.walletReconciliationMismatches.increment();
  }

  recordTransactionStatus(status: string): void {
    this.transactionsByStatus.increment({ status });
  }

  incrementDuplicateCount(): void {
    this.duplicates.increment();
  }

  incrementRetry(source: 'sqs' | 'outbox'): void {
    this.retries.increment({ source });
  }

  incrementDeadLetterCount(): void {
    this.deadLetters.increment();
  }

  incrementLockConflictCount(): void {
    this.lockConflicts.increment();
  }

  observeProcessingLatency(milliseconds: number): void {
    this.processingLatency.observe(milliseconds);
  }

  observeOutboxLag(milliseconds: number): void {
    this.outboxLag.observe(milliseconds);
  }
}
