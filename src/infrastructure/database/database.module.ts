import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from './mikro-orm/schema.js';

export const DATABASE_ORM = Symbol('DATABASE_ORM');

function databasePoolMax(environment: NodeJS.ProcessEnv): number {
  const rawValue = environment.DATABASE_POOL_MAX;
  if (rawValue === undefined) {
    return 10;
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('DATABASE_POOL_MAX must be a positive integer.');
  }
  return value;
}

class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_ORM,
      useFactory: async () => {
        const clientUrl = process.env.DATABASE_URL;
        if (!clientUrl) {
          throw new Error('DATABASE_URL must be configured.');
        }
        return MikroORM.init({
          clientUrl,
          ensureDatabase: false,
          pool: { max: databasePoolMax(process.env) },
          entities: [
            WalletSchema,
            WagerTransactionSchema,
            WalletLedgerEntrySchema,
            InboxMessageSchema,
            OutboxMessageSchema,
          ],
        });
      },
    },
    {
      provide: DatabaseLifecycle,
      useFactory: (orm: MikroORM) => new DatabaseLifecycle(orm),
      inject: [DATABASE_ORM],
    },
  ],
  exports: [DATABASE_ORM],
})
export class DatabaseModule {}
