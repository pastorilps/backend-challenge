import { Module } from '@nestjs/common';
import { createObserveModule, TracerService } from '@nestjs/observe';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from './application/wallets/create-wallet/create-wallet.use-case.js';
import { GetWalletLedgerUseCase } from './application/wallets/get-wallet/get-wallet-ledger.use-case.js';
import { GetWalletUseCase } from './application/wallets/get-wallet/get-wallet.use-case.js';
import { ReconcileWalletUseCase } from './application/wallets/reconcile-wallet/reconcile-wallet.use-case.js';
import { GetWagerTransactionUseCase } from './application/wagering/get-wager-transaction/get-wager-transaction.use-case.js';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import { MikroOrmIdempotencyExecutor } from './infrastructure/database/mikro-orm/repositories/mikro-orm-idempotency.executor.js';
import { MikroOrmWagerTransactionProcessor } from './infrastructure/database/mikro-orm/repositories/mikro-orm-wager-transaction.processor.js';
import {
  DatabaseModule,
  DATABASE_ORM,
} from './infrastructure/database/database.module.js';
import { HealthController } from './presentation/http/health/health.controller.js';
import { WageringController } from './presentation/http/wagering/wagering.controller.js';
import { WalletsController } from './presentation/http/wallets/wallets.controller.js';
import { ProviderIdentityGuard } from './presentation/http/auth/provider-identity.guard.js';
import { AppMetrics } from './infrastructure/observability/metrics/app-metrics.js';
import {
  SQS_QUEUE_CLIENT,
  SqsModule,
} from './infrastructure/messaging/sqs/sqs.module.js';
import { SqsQueueClient } from './infrastructure/messaging/sqs/sqs-queue-client.js';
import {
  loadWagerTransactionSqsConsumerConfig,
  WagerTransactionSqsConsumer,
} from './infrastructure/messaging/sqs/consumers/wager-transaction.consumer.js';
import {
  loadSqsOutboxPublisherConfig,
  SqsEventPublisher,
} from './infrastructure/messaging/sqs/publishers/sqs-event.publisher.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    DatabaseModule,
    SqsModule,
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'backend-challenge',
    }),
  ],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    ProviderIdentityGuard,
    {
      provide: CreateWalletUseCase,
      useFactory: (orm: MikroORM) => new CreateWalletUseCase(orm),
      inject: [DATABASE_ORM],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (orm: MikroORM) => new GetWalletUseCase(orm.em),
      inject: [DATABASE_ORM],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (orm: MikroORM) => new GetWalletLedgerUseCase(orm.em),
      inject: [DATABASE_ORM],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (orm: MikroORM, metrics: AppMetrics) =>
        new ReconcileWalletUseCase(orm.em, metrics),
      inject: [DATABASE_ORM, AppMetrics],
    },
    {
      provide: AppMetrics,
      useFactory: (tracer: TracerService) => new AppMetrics(tracer),
      inject: [TracerService],
    },
    {
      provide: GetWagerTransactionUseCase,
      useFactory: (orm: MikroORM) => new GetWagerTransactionUseCase(orm.em),
      inject: [DATABASE_ORM],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (orm: MikroORM, metrics: AppMetrics) =>
        new ProcessWagerTransactionUseCase(
          new MikroOrmIdempotencyExecutor(orm.em, metrics),
          new MikroOrmWagerTransactionProcessor(),
          metrics,
        ),
      inject: [DATABASE_ORM, AppMetrics],
    },
    {
      provide: WagerTransactionSqsConsumer,
      useFactory: (
        queueClient: SqsQueueClient,
        processWagerTransaction: ProcessWagerTransactionUseCase,
        metrics: AppMetrics,
      ) =>
        new WagerTransactionSqsConsumer(
          queueClient,
          processWagerTransaction,
          loadWagerTransactionSqsConsumerConfig(),
          metrics,
        ),
      inject: [SQS_QUEUE_CLIENT, ProcessWagerTransactionUseCase, AppMetrics],
    },
    {
      provide: SqsEventPublisher,
      useFactory: (
        orm: MikroORM,
        queueClient: SqsQueueClient,
        metrics: AppMetrics,
      ) =>
        new SqsEventPublisher(
          orm.em,
          queueClient,
          loadSqsOutboxPublisherConfig(),
          metrics,
        ),
      inject: [DATABASE_ORM, SQS_QUEUE_CLIENT, AppMetrics],
    },
  ],
})
export class AppModule {}
