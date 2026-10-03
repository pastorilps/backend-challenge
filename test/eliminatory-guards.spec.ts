import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(join(repositoryRoot, relativePath), 'utf8');
}

describe('eliminatory regression guards', () => {
  it('keeps money inputs decimal-string based and uses bigint minor units', async () => {
    const money = await source('src/domain/wallet/value-objects/money.ts');

    expect(money).toMatch(/interface MoneyProps\s*\{\s*amount:\s*string;/);
    expect(money).toMatch(/private readonly minorUnits:\s*bigint/);
    expect(money).toMatch(/typeof props\.amount !== 'string'/);
    expect(money).not.toMatch(/\b(?:parseFloat|parseInt)\s*\(/);
    expect(money).not.toMatch(/\bNumber\s*\(/);
  });

  it('keeps persisted wallet, transaction, and ledger amounts as PostgreSQL numeric', async () => {
    const schema = await source(
      'src/infrastructure/database/mikro-orm/schema.ts',
    );

    expect(schema).toMatch(/balanceAmount:\s*\{[^}]*type:\s*'numeric'[^}]*precision:\s*19[^}]*scale:\s*2/);
    expect(schema).toMatch(/moneyAmount:\s*\{[^}]*type:\s*'numeric'[^}]*precision:\s*19[^}]*scale:\s*2/);
    expect(schema).toMatch(/balanceBeforeAmount:\s*\{[^}]*type:\s*'numeric'[^}]*precision:\s*19[^}]*scale:\s*2/);
    expect(schema).toMatch(/balanceAfterAmount:\s*\{[^}]*type:\s*'numeric'[^}]*precision:\s*19[^}]*scale:\s*2/);
  });

  it('persists idempotency under a PostgreSQL transaction and advisory lock', async () => {
    const executor = await source(
      'src/infrastructure/database/mikro-orm/repositories/mikro-orm-idempotency.executor.ts',
    );
    const lock = await source(
      'src/infrastructure/database/mikro-orm/repositories/transaction-advisory-lock.ts',
    );
    const schema = await source(
      'src/infrastructure/database/mikro-orm/schema.ts',
    );

    expect(executor).toMatch(/entityManager\.transactional\s*\(/);
    expect(executor).toMatch(/acquireTransactionAdvisoryLock\s*\(/);
    expect(executor).toMatch(/idempotencyKey/);
    expect(lock).toMatch(/getTransactionContext\s*\(\)/);
    expect(lock).toMatch(/transactionContext/);
    expect(schema).toMatch(/name:\s*'wager_transactions_idempotency_key_uq'/);
    expect(executor).not.toMatch(/new Map\s*</);
  });

  it('claims outbox rows with PostgreSQL skip-locked semantics', async () => {
    const publisher = await source(
      'src/infrastructure/messaging/sqs/publishers/sqs-event.publisher.ts',
    );

    expect(publisher).toMatch(/for update skip locked/i);
    expect(publisher).toMatch(/publishEvent\s*\(/);
    expect(publisher).toMatch(/transactional\s*\(/);
  });

  it('keeps real PostgreSQL and MiniStack integration fixtures in the suite', async () => {
    const integrationTest = await source('test/sqs-postgres.integration.spec.ts');

    expect(integrationTest).toMatch(/MikroORM/);
    expect(integrationTest).toMatch(/SQSClient/);
    expect(integrationTest).toMatch(/MikroORM\.init\s*\(/);
    expect(integrationTest).toMatch(/new SQSClient\s*\(/);
    expect(integrationTest).toMatch(/TEST_DATABASE_URL/);
    expect(integrationTest).toMatch(/TEST_SQS_ENDPOINT_URL/);
    expect(integrationTest).toMatch(/integrationEnabled/);
  });

  it('does not mark an absent container topology as complete coverage', async () => {
    const runner = await source('scripts/run-test-report.mjs');

    expect(runner).toMatch(/'PARTIAL'/);
    expect(runner).toMatch(/'NOT RUN'/);
    expect(runner).toMatch(/backend-challenge-tests/);
    expect(runner).toMatch(/randomUUID\(\)/);
  });
});
