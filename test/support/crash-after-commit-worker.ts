import { createHash } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from '../../src/infrastructure/database/mikro-orm/schema.js';
import { MikroOrmIdempotencyExecutor } from '../../src/infrastructure/database/mikro-orm/repositories/mikro-orm-idempotency.executor.js';
import { MikroOrmWagerTransactionProcessor } from '../../src/infrastructure/database/mikro-orm/repositories/mikro-orm-wager-transaction.processor.js';
import { AwsSqsQueueClient } from '../../src/infrastructure/messaging/sqs/aws-sqs-queue.client.js';
import { SQSClient } from '@aws-sdk/client-sqs';

async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const endpoint = process.env.TEST_SQS_ENDPOINT_URL;
  const queueUrl = process.env.TEST_SQS_QUEUE_URL;
  const consumerName = process.env.TEST_SQS_CONSUMER_NAME;
  if (!databaseUrl || !endpoint || !queueUrl || !consumerName) {
    throw new Error(
      'Crash integration worker is missing its test configuration.',
    );
  }

  const orm = await MikroORM.init({
    clientUrl: databaseUrl,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
  });
  const sqsClient = new SQSClient({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  const sqs = new AwsSqsQueueClient(sqsClient);
  try {
    const message = await receiveMessage(sqs, queueUrl);
    if (!message.body || !message.messageId) {
      throw new Error(
        'Crash integration worker received an incomplete message.',
      );
    }
    const envelope = JSON.parse(message.body) as {
      messageId: string;
      data: Parameters<ProcessWagerTransactionUseCase['execute']>[0] & {
        idempotencyKey: string;
      };
    };
    const useCase = new ProcessWagerTransactionUseCase(
      new MikroOrmIdempotencyExecutor(orm.em),
      new MikroOrmWagerTransactionProcessor(),
    );
    await useCase.execute(envelope.data, envelope.data.idempotencyKey, {
      consumerName,
      messageId: envelope.messageId,
      correlationId: envelope.messageId,
      payloadHash: createHash('sha256')
        .update(message.body, 'utf8')
        .digest('hex'),
      payloadJson: JSON.parse(message.body) as Readonly<
        Record<string, unknown>
      >,
      attempts: Number(message.approximateReceiveCount ?? 1),
    });
    console.log('COMMITTED_BEFORE_ACK');
  } finally {
    await orm.close(true);
    sqs.onApplicationShutdown();
  }
}

async function receiveMessage(sqs: AwsSqsQueueClient, queueUrl: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const messages = await sqs.receiveMessages(
      queueUrl,
      1,
      1,
      new AbortController().signal,
    );
    if (messages[0]) {
      return messages[0];
    }
  }
  throw new Error('Timed out waiting for a source queue message.');
}

main()
  .then(() => {
    process.exitCode = 73;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
