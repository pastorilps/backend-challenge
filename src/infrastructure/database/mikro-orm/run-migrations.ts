import 'dotenv/config';
import { MikroORM } from '@mikro-orm/postgresql';
import { fileURLToPath } from 'node:url';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from './schema.js';

const tableNames = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
] as const;

const legacyMigrationNames = [
  'Migration20261003124500_AddIdempotencyResponse',
  'Migration20261003125200_AddPendingReferenceRetries',
  'Migration20261003125500_AllowRejectedCurrencyAudit',
] as const;

async function runMigrations(): Promise<void> {
  const clientUrl = process.env.DATABASE_URL;
  if (!clientUrl) {
    throw new Error(
      'DATABASE_URL must be configured before running migrations.',
    );
  }

  const orm = await MikroORM.init({
    clientUrl,
    ensureDatabase: false,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
    migrations: {
      path: fileURLToPath(new URL('./migrations/', import.meta.url)),
      glob: '!(*.d).js',
      transactional: true,
      allOrNothing: true,
      disableForeignKeys: true,
    },
  });

  try {
    const existingTables = (await orm.em.getConnection().execute(
      `select table_name
         from information_schema.tables
        where table_schema = current_schema()
          and table_name in (${tableNames.map(() => '?').join(', ')})`,
      [...tableNames],
    )) as Array<{ table_name: string }>;
    const existingNames = new Set(
      existingTables.map(({ table_name }) => table_name),
    );

    if (existingNames.size === 0) {
      await orm.schema.create();
      const migrator = orm.migrator;
      const baselineMigrations = await migrator.getPending();
      for (const migration of baselineMigrations) {
        await migrator.getStorage().logMigration({ name: migration.name });
      }
      console.info(
        'Created the current PostgreSQL schema and recorded its migration baseline.',
      );
      return;
    }

    const missingTables = tableNames.filter((name) => !existingNames.has(name));
    if (missingTables.length > 0) {
      throw new Error(
        `Refusing to migrate a partially initialized schema. Missing tables: ${missingTables.join(', ')}.`,
      );
    }

    const migrator = orm.migrator;
    const columns = (await orm.em.getConnection().execute(
      `select column_name
         from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'wager_transactions'
          and column_name in (
            'idempotency_response',
            'reference_attempts',
            'reference_next_attempt_at'
          )`,
    )) as Array<{ column_name: string }>;
    const referenceRetryIndex = (await orm.em.getConnection().execute(
      `select indexname
         from pg_indexes
        where schemaname = current_schema()
          and tablename = 'wager_transactions'
          and indexname = 'wager_transactions_pending_reference_idx'`,
    )) as Array<{ indexname: string }>;
    const currencyCheck = (await orm.em.getConnection().execute(
      `select conname
         from pg_constraint
        where conrelid = 'wager_transactions'::regclass
          and conname = 'wager_transactions_money_currency_check'`,
    )) as Array<{ conname: string }>;
    const hasCurrentSchema =
      columns.length === 3 &&
      referenceRetryIndex.length === 1 &&
      currencyCheck.length === 0;

    if (hasCurrentSchema) {
      const pendingMigrations = await migrator.getPending();
      const pendingNames = new Set(pendingMigrations.map(({ name }) => name));
      for (const name of legacyMigrationNames) {
        if (pendingNames.has(name)) {
          await migrator.getStorage().logMigration({ name });
        }
      }
    }

    await migrator.up();
    console.info('PostgreSQL migrations are up to date.');
  } finally {
    await orm.close(true);
  }
}

runMigrations().catch((error: unknown) => {
  console.error('Database initialization failed.', error);
  process.exitCode = 1;
});
