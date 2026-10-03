import { MikroORM } from '@mikro-orm/postgresql';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateWalletUseCase } from '../src/application/wallets/create-wallet/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../src/application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../src/domain/wagering/enums/wager-transaction-kind.js';
import { InboxMessageOrmEntity } from '../src/infrastructure/database/mikro-orm/entities/inbox-message.orm-entity.js';
import { OutboxMessageOrmEntity } from '../src/infrastructure/database/mikro-orm/entities/outbox-message.orm-entity.js';
import { WagerTransactionOrmEntity } from '../src/infrastructure/database/mikro-orm/entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from '../src/infrastructure/database/mikro-orm/entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../src/infrastructure/database/mikro-orm/entities/wallet.orm-entity.js';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from '../src/infrastructure/database/mikro-orm/schema.js';
import { MikroOrmIdempotencyExecutor } from '../src/infrastructure/database/mikro-orm/repositories/mikro-orm-idempotency.executor.js';
import { MikroOrmWagerTransactionProcessor } from '../src/infrastructure/database/mikro-orm/repositories/mikro-orm-wager-transaction.processor.js';
import { WagerTransactionSqsConsumer } from '../src/infrastructure/messaging/sqs/consumers/wager-transaction.consumer.js';
import { AwsSqsQueueClient } from '../src/infrastructure/messaging/sqs/aws-sqs-queue.client.js';
import { SqsEventPublisher } from '../src/infrastructure/messaging/sqs/publishers/sqs-event.publisher.js';
import { SqsReceivedMessage } from '../src/infrastructure/messaging/sqs/sqs-queue-client.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const endpoint = process.env.TEST_SQS_ENDPOINT_URL;
const sourceQueueUrl = process.env.TEST_SQS_QUEUE_URL;
const deadLetterQueueUrl = process.env.TEST_SQS_DLQ_URL;
const eventsQueueUrl = process.env.TEST_SQS_EVENTS_QUEUE_URL;
const integrationEnabled = Boolean(
  databaseUrl &&
  endpoint &&
  sourceQueueUrl &&
  deadLetterQueueUrl &&
  eventsQueueUrl,
);
const integration = integrationEnabled ? describe : describe.skip;

integration('PostgreSQL and MiniStack integration', () => {
  let orm: MikroORM;
  let sqs: AwsSqsQueueClient;
  let sqsClient: SQSClient;
  let crashQueueUrl: string | undefined;
  let consumerName: string;
  let walletId: string | undefined;
  let messageId: string | undefined;
  let dlqMessageId: string | undefined;
  const additionalInboxMessageIds: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl || !endpoint || !sourceQueueUrl || !deadLetterQueueUrl) {
      throw new Error('Integration services are not fully configured.');
    }
    orm = await createOrm(databaseUrl);
    sqsClient = new SQSClient({
      endpoint,
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    sqs = new AwsSqsQueueClient(sqsClient);
    const crashQueue = await sqsClient.send(
      new CreateQueueCommand({
        QueueName: `wager-crash-test-${randomUUID()}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '1',
        },
      }),
    );
    if (!crashQueue.QueueUrl) {
      throw new Error('MiniStack did not return the crash queue URL.');
    }
    crashQueueUrl = crashQueue.QueueUrl;
    consumerName = `integration-${randomUUID()}`;
  }, 30_000);

  afterAll(async () => {
    try {
      if (walletId) {
        const em = orm.em.fork();
        const inboxMessageIds = [
          ...(messageId ? [messageId] : []),
          ...(dlqMessageId ? [dlqMessageId] : []),
          ...additionalInboxMessageIds,
        ];
        if (inboxMessageIds.length > 0) {
          await em.nativeDelete(InboxMessageOrmEntity, {
            consumerName,
            messageId: { $in: inboxMessageIds },
          });
        }
        const transactions = await em.find(WagerTransactionOrmEntity, {
          wallet: walletId,
        });
        await em.nativeDelete(OutboxMessageOrmEntity, {
          aggregateId: {
            $in: [walletId, ...transactions.map(({ id }) => id)],
          },
        });
        await em.nativeDelete(WalletLedgerEntryOrmEntity, {
          wallet: walletId,
        });
        await em.nativeDelete(WagerTransactionOrmEntity, {
          wallet: walletId,
        });
        await em.nativeDelete(WalletOrmEntity, { id: walletId });
      }
    } finally {
      if (crashQueueUrl) {
        await sqsClient.send(
          new DeleteQueueCommand({ QueueUrl: crashQueueUrl }),
        );
      }
      await orm?.close(true);
      sqs?.onApplicationShutdown();
    }
  });

  it('processes SQS through inbox, persists financial state, publishes outbox, and routes invalid input to DLQ', async () => {
    if (!sourceQueueUrl || !deadLetterQueueUrl || !eventsQueueUrl) {
      throw new Error('Integration queue URLs are not fully configured.');
    }
    if (!crashQueueUrl) {
      throw new Error('MiniStack crash queue is not configured.');
    }
    const createdWallet = await new CreateWalletUseCase(orm).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    walletId = createdWallet.id;
    messageId = `integration-message-${randomUUID()}`;
    dlqMessageId = `invalid-${randomUUID()}`;
    const externalTransactionId = `integration-wager-${randomUUID()}`;
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'integration-provider',
        externalTransactionId,
        idempotencyKey: `integration-key-${randomUUID()}`,
        playerId: createdWallet.playerId,
        walletId,
        roundId: `round-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      },
    });
    await sqs.publishEvent(crashQueueUrl, body, walletId, messageId);

    const crashResult = await runCrashWorker(consumerName, crashQueueUrl);
    expect(crashResult.code).toBe(73);
    expect(crashResult.stdout).toContain('COMMITTED_BEFORE_ACK');
    await orm.close(true);
    if (!databaseUrl) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    orm = await createOrm(databaseUrl);

    const redeliveredMessage = await receiveRequired(crashQueueUrl);
    expect(Number(redeliveredMessage.approximateReceiveCount)).toBeGreaterThan(
      1,
    );
    const useCase = new ProcessWagerTransactionUseCase(
      new MikroOrmIdempotencyExecutor(orm.em),
      new MikroOrmWagerTransactionProcessor(),
    );
    const consumer = new WagerTransactionSqsConsumer(sqs, useCase, {
      queueUrl: crashQueueUrl,
      deadLetterQueueUrl,
      consumerName,
      maxAttempts: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      visibilityTimeoutSeconds: 5,
      waitTimeSeconds: 1,
    });
    await consumer.handleMessage(redeliveredMessage);
    await sqsClient.send(new DeleteQueueCommand({ QueueUrl: crashQueueUrl }));
    crashQueueUrl = undefined;

    const em = orm.em.fork();
    const persistedWallet = await em.findOneOrFail(WalletOrmEntity, {
      id: walletId,
    });
    const persistedInbox = await em.findOneOrFail(InboxMessageOrmEntity, {
      consumerName,
      messageId,
    });
    const transaction = await em.findOneOrFail(WagerTransactionOrmEntity, {
      providerId: 'integration-provider',
      externalTransactionId,
    });
    const ledgerEntries = await em.find(WalletLedgerEntryOrmEntity, {
      wallet: walletId,
    });
    const outboxMessages = await em.find(OutboxMessageOrmEntity, {
      aggregateId: walletId,
      status: 'PENDING',
    });
    expect(persistedWallet.balanceAmount).toBe('90.00');
    expect(persistedInbox.status).toBe('PROCESSED');
    expect(transaction.status).toBe('PROCESSED');
    expect(ledgerEntries).toHaveLength(2);
    expect(outboxMessages).toHaveLength(2);

    const ledgerTotal = (await em.getConnection().execute(
      `select coalesce(
                sum(case when direction = 'CREDIT' then amount else -amount end),
                0
              )::text as balance
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    )) as Array<{ balance: string }>;
    expect(ledgerTotal[0].balance).toBe(persistedWallet.balanceAmount);

    const eventIds = outboxMessages.map(
      ({ payloadJson }) => payloadJson.eventId as string,
    );
    const publisher = new SqsEventPublisher(orm.em, sqs, {
      queueUrl: eventsQueueUrl,
      batchSize: 10,
      pollIntervalMs: 1_000,
    });
    await expect(publisher.publishDueBatch()).resolves.toBe(2);
    const publishedEvents: (string | undefined)[] = [];
    for (let index = 0; index < eventIds.length; index += 1) {
      const event = await receiveRequired(eventsQueueUrl);
      const payload = JSON.parse(event.body ?? '{}') as { eventId?: string };
      await deleteReceivedMessage(eventsQueueUrl, event);
      publishedEvents.push(payload.eventId);
    }
    expect(
      publishedEvents.sort((left, right) =>
        (left ?? '').localeCompare(right ?? ''),
      ),
    ).toEqual(eventIds.sort((left, right) => left.localeCompare(right)));

    const processingUseCase = new ProcessWagerTransactionUseCase(
      new MikroOrmIdempotencyExecutor(orm.em),
      new MikroOrmWagerTransactionProcessor(),
    );
    const concurrentExternalId = `concurrent-outbox-${randomUUID()}`;
    await processingUseCase.execute(
      {
        providerId: 'integration-provider',
        externalTransactionId: concurrentExternalId,
        playerId: createdWallet.playerId,
        walletId,
        roundId: `round-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '1.00', currency: 'BRL' },
      },
      `concurrent-outbox-key-${randomUUID()}`,
    );
    const concurrentPublishers = [0, 1].map(
      () =>
        new SqsEventPublisher(orm.em.fork(), sqs, {
          queueUrl: eventsQueueUrl,
          batchSize: 1,
          pollIntervalMs: 1_000,
        }),
    );
    const concurrentPublishCounts = await Promise.all(
      concurrentPublishers.map((concurrentPublisher) =>
        concurrentPublisher.publishDueBatch(),
      ),
    );
    expect(concurrentPublishCounts.reduce((total, count) => total + count, 0)).toBe(2);
    const concurrentEvents: (string | undefined)[] = [];
    for (const publishCount of concurrentPublishCounts) {
      for (let index = 0; index < publishCount; index += 1) {
        const event = await receiveRequired(eventsQueueUrl);
        const payload = JSON.parse(event.body ?? '{}') as { eventId?: string };
        await deleteReceivedMessage(eventsQueueUrl, event);
        concurrentEvents.push(payload.eventId);
      }
    }
    expect(new Set(concurrentEvents).size).toBe(2);

    const retryExternalId = `retry-outbox-${randomUUID()}`;
    await processingUseCase.execute(
      {
        providerId: 'integration-provider',
        externalTransactionId: retryExternalId,
        playerId: createdWallet.playerId,
        walletId,
        roundId: `round-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '1.00', currency: 'BRL' },
      },
      `retry-outbox-key-${randomUUID()}`,
    );
    const retryMessages = await orm.em.fork().find(OutboxMessageOrmEntity, {
      aggregateId: walletId,
      status: 'PENDING',
    });
    expect(retryMessages).toHaveLength(2);
    const retryPublisher = new SqsEventPublisher(orm.em.fork(), sqs, {
      queueUrl: `${endpoint}/000000000000/missing-events-${randomUUID()}.fifo`,
      batchSize: 10,
      pollIntervalMs: 1_000,
    });
    await expect(retryPublisher.publishDueBatch()).resolves.toBe(0);
    const scheduledRetries = await orm.em.fork().find(OutboxMessageOrmEntity, {
      id: { $in: retryMessages.map(({ id }) => id) },
    });
    expect(scheduledRetries.map(({ attempts }) => attempts)).toEqual([1, 1]);
    expect(
      scheduledRetries.every((message) => message.nextAttemptAt instanceof Date),
    ).toBe(true);

    const realQueueRetryPublisher = new SqsEventPublisher(orm.em.fork(), sqs, {
      queueUrl: eventsQueueUrl,
      batchSize: 10,
      pollIntervalMs: 1_000,
    });
    await expect(
      realQueueRetryPublisher.publishDueBatch(
        new Date(Date.now() + 5_000),
      ),
    ).resolves.toBe(2);
    const retriedEvents: (string | undefined)[] = [];
    for (let index = 0; index < scheduledRetries.length; index += 1) {
      const event = await receiveRequired(eventsQueueUrl);
      const payload = JSON.parse(event.body ?? '{}') as { eventId?: string };
      await deleteReceivedMessage(eventsQueueUrl, event);
      retriedEvents.push(payload.eventId);
    }
    expect(new Set(retriedEvents).size).toBe(2);

    await sqs.publishEvent(
      sourceQueueUrl,
      '{invalid-json',
      `invalid-group-${randomUUID()}`,
      dlqMessageId,
    );
    const invalidMessage = await receiveRequired(sourceQueueUrl);
    const sourceConsumer = new WagerTransactionSqsConsumer(sqs, useCase, {
      queueUrl: sourceQueueUrl,
      deadLetterQueueUrl,
      consumerName,
      maxAttempts: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      visibilityTimeoutSeconds: 5,
      waitTimeSeconds: 1,
    });
    await sourceConsumer.handleMessage(invalidMessage);
    const deadLetterMessage = await receiveRequired(deadLetterQueueUrl);
    expect(deadLetterMessage.body).toBe('{invalid-json');
    await deleteReceivedMessage(deadLetterQueueUrl, deadLetterMessage);

    const referenceBetId = `reference-bet-${randomUUID()}`;
    const refundMessageId = `out-of-order-refund-${randomUUID()}`;
    additionalInboxMessageIds.push(refundMessageId);
    const refundBody = JSON.stringify({
      messageId: refundMessageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'integration-provider',
        externalTransactionId: `refund-${randomUUID()}`,
        idempotencyKey: `refund-key-${randomUUID()}`,
        playerId: createdWallet.playerId,
        walletId,
        roundId: `round-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Refund,
        money: { amount: '2.00', currency: 'BRL' },
        referenceExternalTransactionId: referenceBetId,
      },
    });
    await sqs.publishEvent(sourceQueueUrl, refundBody, walletId, refundMessageId);
    await sourceConsumer.handleMessage(await receiveRequired(sourceQueueUrl));
    const pendingRefund = await orm.em.fork().findOneOrFail(
      WagerTransactionOrmEntity,
      { providerId: 'integration-provider', externalTransactionId: JSON.parse(refundBody).data.externalTransactionId },
    );
    expect(pendingRefund.status).toBe('PENDING_REFERENCE');

    const referenceBetMessageId = `out-of-order-bet-${randomUUID()}`;
    additionalInboxMessageIds.push(referenceBetMessageId);
    const referenceBetBody = JSON.stringify({
      messageId: referenceBetMessageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'integration-provider',
        externalTransactionId: referenceBetId,
        idempotencyKey: `reference-bet-key-${randomUUID()}`,
        playerId: createdWallet.playerId,
        walletId,
        roundId: JSON.parse(refundBody).data.roundId,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '2.00', currency: 'BRL' },
      },
    });
    await sqs.publishEvent(
      sourceQueueUrl,
      referenceBetBody,
      walletId,
      referenceBetMessageId,
    );
    await sourceConsumer.handleMessage(await receiveRequired(sourceQueueUrl));
    const referenceProcessor = new MikroOrmWagerTransactionProcessor();
    await expect(
      referenceProcessor.reprocessPendingReferences(
        orm.em.fork(),
        new Date(Date.now() + 5_000),
        10,
      ),
    ).resolves.toBe(1);
    const processedRefund = await orm.em.fork().findOneOrFail(
      WagerTransactionOrmEntity,
      { id: pendingRefund.id },
    );
    expect(processedRefund.status).toBe('PROCESSED');

    const finalWallet = await orm.em.fork().findOneOrFail(WalletOrmEntity, {
      id: walletId,
    });
    const finalLedgerBalance = (await orm.em.fork().getConnection().execute(
      `select coalesce(
                sum(case when direction = 'CREDIT' then amount else -amount end),
                0
              )::text as balance
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    )) as Array<{ balance: string }>;
    expect(finalLedgerBalance[0].balance).toBe(finalWallet.balanceAmount);
  }, 60_000);

  async function receiveRequired(
    queueUrl: string,
  ): Promise<SqsReceivedMessage> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const messages = await sqs.receiveMessages(
        queueUrl,
        1,
        5,
        new AbortController().signal,
      );
      if (messages[0]) {
        return messages[0];
      }
    }
    throw new Error(
      `Timed out waiting for an integration message on ${queueUrl}.`,
    );
  }

  async function deleteReceivedMessage(
    queueUrl: string,
    message: SqsReceivedMessage,
  ): Promise<void> {
    if (!message.receiptHandle) {
      throw new Error(
        'Integration message was received without a receipt handle.',
      );
    }
    await sqs.deleteMessage(queueUrl, message.receiptHandle);
  }

  function runCrashWorker(
    workerConsumerName: string,
    workerQueueUrl: string,
  ): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolveResult, reject) => {
      const worker = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve(
            process.cwd(),
            'test',
            'support',
            'crash-after-commit-worker.ts',
          ),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            TEST_SQS_CONSUMER_NAME: workerConsumerName,
            TEST_SQS_QUEUE_URL: workerQueueUrl,
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
        if (code !== 73) {
          reject(
            new Error(`Crash worker exited with ${code}; stderr: ${stderr}`),
          );
          return;
        }
        resolveResult({ code, stdout });
      });
    });
  }
});

async function createOrm(clientUrl: string): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl,
    ensureDatabase: false,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
  });
}
