import 'dotenv/config';
import { defineConfig } from '@mikro-orm/postgresql';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from './src/infrastructure/database/mikro-orm/schema.js';

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ||
    'postgresql://root:rootpassword@localhost:5432/my_database',

  entities: [
    WalletSchema,
    WagerTransactionSchema,
    WalletLedgerEntrySchema,
    InboxMessageSchema,
    OutboxMessageSchema,
  ],

  migrations: {
    path: './dist/infrastructure/database/mikro-orm/migrations',
    pathTs: './src/infrastructure/database/mikro-orm/migrations',
    glob: '!(*.d).{js,ts}',

    transactional: true,
    allOrNothing: true,
    disableForeignKeys: true,

    tableName: 'mikro_orm_migrations',
  },
});
