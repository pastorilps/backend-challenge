import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import { ProcessWagerTransactionInput } from '../../src/application/wagering/process-wager-transaction/idempotency.types.js';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from '../../src/infrastructure/database/mikro-orm/schema.js';
import { MikroOrmIdempotencyExecutor } from '../../src/infrastructure/database/mikro-orm/repositories/mikro-orm-idempotency.executor.js';
import { MikroOrmWagerTransactionProcessor } from '../../src/infrastructure/database/mikro-orm/repositories/mikro-orm-wager-transaction.processor.js';

interface WorkerInput {
  databaseUrl: string;
  requestCount: number;
  startAt: number;
  operation: ProcessWagerTransactionInput;
  idempotencyKey: string;
  inboxReceipt: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
    payloadJson: Readonly<Record<string, unknown>>;
    attempts: number;
  };
}

async function main(): Promise<void> {
  const rawInput = process.env.WORKER_INPUT;
  if (!rawInput) {
    throw new Error('WORKER_INPUT is required.');
  }
  const input = JSON.parse(rawInput) as WorkerInput;
  const orm = await MikroORM.init({
    clientUrl: input.databaseUrl,
    ensureDatabase: false,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
  });
  try {
    while (Date.now() < input.startAt) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const useCase = new ProcessWagerTransactionUseCase(
      new MikroOrmIdempotencyExecutor(orm.em),
      new MikroOrmWagerTransactionProcessor(),
    );
    const results = await Promise.all(
      Array.from({ length: input.requestCount }, () =>
        useCase.execute(
          input.operation,
          input.idempotencyKey,
          input.inboxReceipt,
        ),
      ),
    );
    console.log(
      `WORKER_RESULT:${JSON.stringify({
        processed: results.filter(({ response }) => !response.idempotentReplay)
          .length,
        replays: results.filter(({ response }) => response.idempotentReplay)
          .length,
      })}`,
    );
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
