import { MikroORM } from '@mikro-orm/postgresql';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessWagerTransactionUseCase } from '../../../../application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import { CreateWalletUseCase } from '../../../../application/wallets/create-wallet/create-wallet.use-case.js';
import { WagerTransactionKind } from '../../../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../../domain/wagering/enums/wager-transaction-status.js';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from '../schema.js';
import { MikroOrmIdempotencyExecutor } from './mikro-orm-idempotency.executor.js';
import { MikroOrmWagerTransactionProcessor } from './mikro-orm-wager-transaction.processor.js';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity.js';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity.js';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../entities/wallet.orm-entity.js';
import { SqsEventPublisher } from '../../../messaging/sqs/publishers/sqs-event.publisher.js';
import { SqsQueueClient } from '../../../messaging/sqs/sqs-queue-client.js';

function getTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required to run database concurrency tests.',
    );
  }
  return url;
}

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration('PostgreSQL wager transaction concurrency', () => {
  const ormInstances: MikroORM[] = [];
  const useCases: ProcessWagerTransactionUseCase[] = [];
  const walletIds: string[] = [];
  const inboxMessageIds: string[] = [];

  beforeAll(async () => {
    for (let index = 0; index < 3; index += 1) {
      const orm = await MikroORM.init({
        clientUrl: getTestDatabaseUrl(),
        ensureDatabase: false,
        entities: [
          WalletSchema,
          WagerTransactionSchema,
          WalletLedgerEntrySchema,
          InboxMessageSchema,
          OutboxMessageSchema,
        ],
      });
      ormInstances.push(orm);
      useCases.push(
        new ProcessWagerTransactionUseCase(
          new MikroOrmIdempotencyExecutor(orm.em),
          new MikroOrmWagerTransactionProcessor(),
        ),
      );
    }
  });

  afterAll(async () => {
    try {
      if (ormInstances.length > 0 && walletIds.length > 0) {
        const em = ormInstances[0].em.fork();
        if (inboxMessageIds.length > 0) {
          await em.nativeDelete(InboxMessageOrmEntity, {
            messageId: { $in: inboxMessageIds },
          });
        }
        const transactions = await em.find(WagerTransactionOrmEntity, {
          wallet: { $in: walletIds },
        });
        await em.nativeDelete(OutboxMessageOrmEntity, {
          aggregateId: {
            $in: [
              ...walletIds,
              ...transactions.map((transaction) => transaction.id),
            ],
          },
        });
        await em.nativeDelete(WalletLedgerEntryOrmEntity, {
          wallet: { $in: walletIds },
        });
        await em.nativeDelete(WagerTransactionOrmEntity, {
          wallet: { $in: walletIds },
        });
        await em.nativeDelete(WalletOrmEntity, { id: { $in: walletIds } });
      }
    } finally {
      await Promise.all(ormInstances.map((orm) => orm.close(true)));
    }
  });

  async function createWallet(balance: string): Promise<string> {
    const wallet = new WalletOrmEntity();
    wallet.id = randomUUID();
    wallet.playerId = randomUUID();
    wallet.currency = 'BRL';
    wallet.balanceAmount = balance;
    wallet.version = 1;
    wallet.createdAt = new Date();
    wallet.updatedAt = wallet.createdAt;
    wallet.wagerTransactions = [];
    wallet.ledgerEntries = [];
    const em = ormInstances[0].em.fork();
    em.persist(wallet);
    await em.flush();
    walletIds.push(wallet.id);
    return wallet.id;
  }

  function request(
    walletId: string,
    externalTransactionId: string,
    amount: string,
  ) {
    return {
      providerId: 'concurrency-test-provider',
      externalTransactionId,
      playerId: 'unused-player-is-overridden',
      walletId,
      roundId: 'concurrency-test-round',
      gameId: 'concurrency-test-game',
      kind: WagerTransactionKind.Bet as const,
      money: { amount, currency: 'BRL' },
    };
  }

  it('applies 50 deliveries across three instances once and replays the original response', async () => {
    const walletId = await createWallet('100.00');
    const payload = request(walletId, `same-${randomUUID()}`, '1.00');
    const wallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    payload.playerId = wallet.playerId;
    const key = `parallel-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;
    inboxMessageIds.push(messageId);
    const inboxReceipt = {
      consumerName: 'concurrency-integration-test',
      messageId,
      payloadHash: 'a'.repeat(64),
      payloadJson: { messageId, type: 'WagerTransactionRequested' },
      attempts: 1,
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        new ProcessWagerTransactionUseCase(
          new MikroOrmIdempotencyExecutor(
            ormInstances[index % ormInstances.length].em.fork(),
          ),
          new MikroOrmWagerTransactionProcessor(),
        ).execute(payload, key, inboxReceipt),
      ),
    );
    const persistedWallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const entryCount = await ormInstances[0].em
      .fork()
      .count(WalletLedgerEntryOrmEntity, { wallet: walletId });
    const outboxCount = await ormInstances[0].em
      .fork()
      .count(OutboxMessageOrmEntity, { aggregateId: walletId });
    const inboxCount = await ormInstances[0].em
      .fork()
      .count(InboxMessageOrmEntity, {
        consumerName: inboxReceipt.consumerName,
        messageId,
        status: 'PROCESSED',
      });

    expect(
      results.filter((result) => result.response.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.response.idempotentReplay === true),
    ).toHaveLength(49);
    expect(persistedWallet.balanceAmount).toBe('99.00');
    expect(entryCount).toBe(1);
    expect(outboxCount).toBe(2);
    expect(inboxCount).toBe(1);
  }, 30_000);

  it('keeps a wager idempotent across three real Node.js processes', async () => {
    const walletId = await createWallet('100.00');
    const wallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const messageId = `multiprocess-${randomUUID()}`;
    inboxMessageIds.push(messageId);
    const input = {
      databaseUrl: getTestDatabaseUrl(),
      requestCount: 15,
      startAt: Date.now() + 2_000,
      operation: request(walletId, `multiprocess-${randomUUID()}`, '1.00'),
      idempotencyKey: `multiprocess-key-${randomUUID()}`,
      inboxReceipt: {
        consumerName: 'multiprocess-concurrency-test',
        messageId,
        payloadHash: 'c'.repeat(64),
        payloadJson: { messageId, type: 'WagerTransactionRequested' },
        attempts: 1,
      },
    };
    input.operation.playerId = wallet.playerId;

    const workerResults = await Promise.all(
      Array.from({ length: 3 }, () => runProcessWorker(input)),
    );
    const persistedWallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const transactions = await ormInstances[0].em
      .fork()
      .find(WagerTransactionOrmEntity, { wallet: walletId });
    const ledgerEntries = await ormInstances[0].em
      .fork()
      .find(WalletLedgerEntryOrmEntity, { wallet: walletId });
    const inbox = await ormInstances[0].em
      .fork()
      .findOneOrFail(InboxMessageOrmEntity, {
        consumerName: 'multiprocess-concurrency-test',
        messageId,
      });

    expect(
      workerResults.reduce((total, result) => total + result.processed, 0),
    ).toBe(1);
    expect(
      workerResults.reduce((total, result) => total + result.replays, 0),
    ).toBe(44);
    expect(persistedWallet.balanceAmount).toBe('99.00');
    expect(transactions).toHaveLength(1);
    expect(ledgerEntries).toHaveLength(1);
    expect(inbox.status).toBe('PROCESSED');
  }, 60_000);

  it('persists terminal business failures in the inbox after rolling back finance', async () => {
    const walletId = await createWallet('100.00');
    const wallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const externalTransactionId = `duplicate-${randomUUID()}`;
    await useCases[0].execute(
      {
        ...request(walletId, externalTransactionId, '10.00'),
        playerId: wallet.playerId,
      },
      `first-key-${randomUUID()}`,
    );

    const messageId = `terminal-${randomUUID()}`;
    inboxMessageIds.push(messageId);
    const inboxReceipt = {
      consumerName: 'concurrency-terminal-test',
      messageId,
      payloadHash: 'b'.repeat(64),
      payloadJson: { messageId, type: 'WagerTransactionRequested' },
      attempts: 1,
    };
    const duplicateOperation = {
      ...request(walletId, externalTransactionId, '10.00'),
      playerId: wallet.playerId,
    };
    const idempotencyKey = `duplicate-key-${randomUUID()}`;

    await expect(
      useCases[1].execute(duplicateOperation, idempotencyKey, inboxReceipt),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_EXTERNAL_TRANSACTION',
      statusCode: 409,
    });
    await expect(
      useCases[2].execute(duplicateOperation, idempotencyKey, inboxReceipt),
    ).rejects.toMatchObject({
      code: 'INBOX_MESSAGE_ALREADY_PROCESSED',
      statusCode: 409,
    });

    const persistedInboxMessage = await ormInstances[0].em
      .fork()
      .findOneOrFail(InboxMessageOrmEntity, {
        consumerName: inboxReceipt.consumerName,
        messageId,
      });
    const persistedWallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const transactionCount = await ormInstances[0].em
      .fork()
      .count(WagerTransactionOrmEntity, {
        providerId: duplicateOperation.providerId,
        externalTransactionId,
      });

    expect(persistedInboxMessage.status).toBe('FAILED');
    expect(persistedInboxMessage.processedAt).toBeInstanceOf(Date);
    expect(persistedWallet.balanceAmount).toBe('90.00');
    expect(transactionCount).toBe(1);
  }, 30_000);

  it('creates a funded wallet with its opening transaction and ledger entry', async () => {
    const created = await new CreateWalletUseCase(ormInstances[0]).execute({
      playerId: `opening-player-${randomUUID()}`,
      initialBalance: { amount: '125.50', currency: 'BRL' },
    });
    walletIds.push(created.id);

    const em = ormInstances[0].em.fork();
    const wallet = await em.findOneOrFail(WalletOrmEntity, { id: created.id });
    const opening = await em.findOneOrFail(WagerTransactionOrmEntity, {
      wallet: created.id,
      kind: 'OPENING',
    });
    const ledgerEntries = await em.find(WalletLedgerEntryOrmEntity, {
      wallet: created.id,
    });

    expect(created.balance).toEqual({ amount: '125.50', currency: 'BRL' });
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toMatchObject({
      direction: 'CREDIT',
      amount: '125.50',
      balanceBeforeAmount: '0.00',
      balanceAfterAmount: '125.50',
    });
    expect(wallet.balanceAmount).toBe('125.50');
  });

  it('has the versioned columns and constraints required by the current schema', async () => {
    const em = ormInstances[0].em.fork();
    const columns = (await em.getConnection().execute(
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
    const constraints = (await em.getConnection().execute(
      `select conname
         from pg_constraint
        where conrelid = 'wager_transactions'::regclass
          and conname in (
            'wager_transactions_idempotency_key_uq',
            'wager_transactions_provider_external_id_uq',
            'wager_transactions_reference_attempts_check'
          )`,
    )) as Array<{ conname: string }>;
    const indexes = (await em.getConnection().execute(
      `select indexname
         from pg_indexes
        where schemaname = current_schema()
          and tablename = 'wager_transactions'
          and indexname = 'wager_transactions_pending_reference_idx'`,
    )) as Array<{ indexname: string }>;

    expect(columns.map(({ column_name }) => column_name).sort()).toEqual([
      'idempotency_response',
      'reference_attempts',
      'reference_next_attempt_at',
    ]);
    expect(constraints.map(({ conname }) => conname).sort()).toEqual([
      'wager_transactions_idempotency_key_uq',
      'wager_transactions_provider_external_id_uq',
      'wager_transactions_reference_attempts_check',
    ]);
    expect(indexes).toHaveLength(1);
  });

  it('allows only one of two concurrent 80.00 bets against a 100.00 wallet', async () => {
    const walletId = await createWallet('100.00');
    const wallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const bets = [
      request(walletId, `bet-a-${randomUUID()}`, '80.00'),
      request(walletId, `bet-b-${randomUUID()}`, '80.00'),
    ].map((input) => ({ ...input, playerId: wallet.playerId }));

    const results = await Promise.all(
      bets.map((input, index) =>
        useCases[index % useCases.length].execute(
          input,
          `key-${input.externalTransactionId}`,
        ),
      ),
    );
    const persistedWallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const entryCount = await ormInstances[0].em
      .fork()
      .count(WalletLedgerEntryOrmEntity, { wallet: walletId });

    const processed = results.filter(
      (result) => result.response.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (result) => result.response.status === WagerTransactionStatus.Rejected,
    );

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].response.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(persistedWallet.balanceAmount).toBe('20.00');
    expect(entryCount).toBe(1);
  }, 30_000);

  it('rejects a duplicate provider transaction across two wallets and instances', async () => {
    const walletIdsForRequest = [
      await createWallet('100.00'),
      await createWallet('100.00'),
    ];
    const wallets = await Promise.all(
      walletIdsForRequest.map((id) =>
        ormInstances[0].em.fork().findOneOrFail(WalletOrmEntity, { id }),
      ),
    );
    const externalTransactionId = `duplicate-${randomUUID()}`;
    const results = await Promise.allSettled(
      walletIdsForRequest.map((walletId, index) =>
        useCases[index].execute(
          {
            ...request(walletId, externalTransactionId, '20.00'),
            playerId: wallets[index].playerId,
          },
          `duplicate-key-${randomUUID()}`,
        ),
      ),
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    const persistedTransactions = await ormInstances[0].em
      .fork()
      .count(WagerTransactionOrmEntity, {
        providerId: 'concurrency-test-provider',
        externalTransactionId,
      });
    const persistedWallets = await Promise.all(
      walletIdsForRequest.map((id) =>
        ormInstances[0].em.fork().findOneOrFail(WalletOrmEntity, { id }),
      ),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'DUPLICATE_EXTERNAL_TRANSACTION', statusCode: 409 },
    });
    expect(persistedTransactions).toBe(1);
    expect(
      persistedWallets.map((wallet) => wallet.balanceAmount).sort(),
    ).toEqual(['100.00', '80.00']);
  }, 30_000);

  it('processes operations on different wallets concurrently without blocking correctness', async () => {
    const walletIdsForRequest = [
      await createWallet('100.00'),
      await createWallet('100.00'),
    ];
    const wallets = await Promise.all(
      walletIdsForRequest.map((id) =>
        ormInstances[0].em.fork().findOneOrFail(WalletOrmEntity, { id }),
      ),
    );
    const results = await Promise.all(
      walletIdsForRequest.map((walletId, index) =>
        useCases[index].execute(
          {
            ...request(walletId, `parallel-wallet-${randomUUID()}`, '10.00'),
            playerId: wallets[index].playerId,
          },
          `parallel-wallet-key-${randomUUID()}`,
        ),
      ),
    );
    const persistedWallets = await Promise.all(
      walletIdsForRequest.map((id) =>
        ormInstances[0].em.fork().findOneOrFail(WalletOrmEntity, { id }),
      ),
    );

    expect(results.map((result) => result.response.status)).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Processed,
    ]);
    expect(persistedWallets.map((wallet) => wallet.balanceAmount)).toEqual([
      '90.00',
      '90.00',
    ]);
  }, 30_000);

  it('allows concurrent outbox publishers to claim separate rows only once', async () => {
    await ormInstances[0].em.fork().nativeDelete(OutboxMessageOrmEntity, {
      status: 'PENDING',
    });
    const walletId = await createWallet('100.00');
    const pendingCountBeforeOperation = await ormInstances[0].em
      .fork()
      .count(OutboxMessageOrmEntity, { status: 'PENDING' });
    const wallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    await useCases[0].execute(
      {
        ...request(walletId, `outbox-${randomUUID()}`, '10.00'),
        playerId: wallet.playerId,
      },
      `outbox-key-${randomUUID()}`,
    );

    const publishedBodies: string[] = [];
    const queueClient: SqsQueueClient = {
      receiveMessages: async () => [],
      deleteMessage: async () => undefined,
      changeMessageVisibility: async () => undefined,
      sendToDeadLetterQueue: async () => undefined,
      publishEvent: async (_url, body) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        publishedBodies.push(body);
      },
    };
    const config = {
      queueUrl: 'http://localhost/events.fifo',
      batchSize: 10,
      pollIntervalMs: 1_000,
    };
    const publishers = [
      new SqsEventPublisher(ormInstances[0].em, queueClient, config),
      new SqsEventPublisher(ormInstances[1].em, queueClient, config),
    ];

    await Promise.all(
      publishers.map((publisher) => publisher.publishDueBatch()),
    );

    const pendingMessages = await ormInstances[0].em
      .fork()
      .find(OutboxMessageOrmEntity, {
        aggregateId: { $in: [walletId] },
        status: 'PENDING',
      });
    const publishedMessages = await ormInstances[0].em
      .fork()
      .find(OutboxMessageOrmEntity, {
        aggregateId: { $in: [walletId] },
        status: 'PUBLISHED',
      });

    expect(publishedBodies).toHaveLength(pendingCountBeforeOperation + 2);
    expect(
      new Set(publishedBodies.map((body) => JSON.parse(body).eventId)).size,
    ).toBe(publishedBodies.length);
    expect(pendingMessages).toHaveLength(0);
    expect(publishedMessages).toHaveLength(2);
  }, 30_000);

  it('retries failed outbox publication with backoff and preserves the event ID', async () => {
    await ormInstances[0].em.fork().nativeDelete(OutboxMessageOrmEntity, {
      status: 'PENDING',
    });
    const walletId = await createWallet('100.00');
    const wallet = await ormInstances[0].em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    await useCases[0].execute(
      {
        ...request(walletId, `outbox-retry-${randomUUID()}`, '10.00'),
        playerId: wallet.playerId,
      },
      `outbox-retry-key-${randomUUID()}`,
    );

    const publishedEventIds: string[] = [];
    let failNextPublish = true;
    const queueClient: SqsQueueClient = {
      receiveMessages: async () => [],
      deleteMessage: async () => undefined,
      changeMessageVisibility: async () => undefined,
      sendToDeadLetterQueue: async () => undefined,
      publishEvent: async (_url, body) => {
        const eventId = JSON.parse(body).eventId as string;
        if (failNextPublish) {
          failNextPublish = false;
          throw new Error('Temporary SQS failure.');
        }
        publishedEventIds.push(eventId);
      },
    };
    const publisher = new SqsEventPublisher(ormInstances[0].em, queueClient, {
      queueUrl: 'http://localhost/events.fifo',
      batchSize: 10,
      pollIntervalMs: 1_000,
    });
    const firstAttemptAt = new Date();

    await expect(publisher.publishDueBatch(firstAttemptAt)).resolves.toBe(1);
    const pendingRetry = await ormInstances[0].em
      .fork()
      .findOneOrFail(OutboxMessageOrmEntity, {
        aggregateId: walletId,
        status: 'PENDING',
      });
    const failedEventId = pendingRetry.payloadJson.eventId as string;
    expect(pendingRetry.attempts).toBe(1);
    expect(pendingRetry.nextAttemptAt?.getTime()).toBeGreaterThan(
      firstAttemptAt.getTime(),
    );

    await publisher.publishDueBatch(
      new Date((pendingRetry.nextAttemptAt?.getTime() ?? 0) + 1),
    );
    const retriedMessage = await ormInstances[0].em
      .fork()
      .findOneOrFail(OutboxMessageOrmEntity, {
        id: pendingRetry.id,
      });

    expect(retriedMessage.status).toBe('PUBLISHED');
    expect(retriedMessage.attempts).toBe(1);
    expect(publishedEventIds).toContain(failedEventId);
  }, 30_000);
});

function runProcessWorker(
  input: object,
): Promise<{ processed: number; replays: number }> {
  return new Promise((resolveResult, reject) => {
    const worker = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(process.cwd(), 'test', 'support', 'wager-process-worker.ts'),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKER_INPUT: JSON.stringify(input),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    worker.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    worker.on('error', reject);
    worker.on('close', (code) => {
      const resultLine = stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('WORKER_RESULT:'));
      if (code !== 0 || !resultLine) {
        reject(
          new Error(
            `Concurrency worker exited with ${code}; stderr: ${stderr}; stdout: ${stdout}`,
          ),
        );
        return;
      }
      resolveResult(
        JSON.parse(resultLine.slice('WORKER_RESULT:'.length)) as {
          processed: number;
          replays: number;
        },
      );
    });
  });
}
