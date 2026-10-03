import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../../shared/errors/app.error.js';
import { WagerTransactionKind } from '../../../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../../domain/wagering/enums/wager-transaction-status.js';
import { ProcessWagerTransactionUseCase } from '../../../../application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import {
  IdempotentExecutionResult,
  WagerTransactionIdempotencyExecutor,
  WagerTransactionOperation,
} from '../../../../application/wagering/process-wager-transaction/idempotency.types.js';
import { WagerTransactionProcessor } from '../../../../application/wagering/process-wager-transaction/wager-transaction-processor.js';
import { SqsQueueClient } from '../sqs-queue-client.js';
import {
  loadWagerTransactionSqsConsumerConfig,
  WagerTransactionSqsConsumer,
} from './wager-transaction.consumer.js';

class TestExecutor extends WagerTransactionIdempotencyExecutor {
  override execute(
    _key: string,
    _hash: string,
    _operation: WagerTransactionOperation,
  ): Promise<IdempotentExecutionResult> {
    throw new Error('The use case should be mocked in these tests.');
  }
}

class TestProcessor extends WagerTransactionProcessor {
  override async process(): Promise<never> {
    throw new Error('The use case should be mocked in these tests.');
  }
}

const config = {
  queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  deadLetterQueueUrl:
    'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  consumerName: 'wager-transaction-consumer',
  maxAttempts: 3,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 8_000,
  visibilityTimeoutSeconds: 60,
  waitTimeSeconds: 20,
};

const body = JSON.stringify({
  messageId: 'message-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-03T12:00:00.000Z',
  data: {
    providerId: 'provider-1',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-1:transaction-1',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
  },
});

function createQueueClient() {
  const receiveMessages = vi
    .fn<SqsQueueClient['receiveMessages']>()
    .mockResolvedValue([]);
  const deleteMessage = vi
    .fn<SqsQueueClient['deleteMessage']>()
    .mockResolvedValue(undefined);
  const changeMessageVisibility = vi
    .fn<SqsQueueClient['changeMessageVisibility']>()
    .mockResolvedValue(undefined);
  const sendToDeadLetterQueue = vi
    .fn<SqsQueueClient['sendToDeadLetterQueue']>()
    .mockResolvedValue(undefined);
  const publishEvent = vi
    .fn<SqsQueueClient['publishEvent']>()
    .mockResolvedValue(undefined);
  const client: SqsQueueClient = {
    receiveMessages,
    deleteMessage,
    changeMessageVisibility,
    sendToDeadLetterQueue,
    publishEvent,
  };
  return {
    client,
    receiveMessages,
    deleteMessage,
    changeMessageVisibility,
    sendToDeadLetterQueue,
    publishEvent,
  };
}

function createUseCase(): ProcessWagerTransactionUseCase {
  return new ProcessWagerTransactionUseCase(
    new TestExecutor(),
    new TestProcessor(),
  );
}

function receivedMessage(
  messageBody = body,
  approximateReceiveCount = '1',
) {
  return {
    messageId: 'sqs-message-1',
    body: messageBody,
    receiptHandle: 'receipt-1',
    approximateReceiveCount,
    messageGroupId: 'provider-1',
  };
}

describe('WagerTransactionSqsConsumer', () => {
  it('runs the shared use case with an inbox receipt before acknowledging', async () => {
    const { client, deleteMessage } = createQueueClient();
    const useCase = createUseCase();
    const execute = vi.spyOn(useCase, 'execute').mockResolvedValue({
      response: {
        transactionId: 'transaction-1',
        status: WagerTransactionStatus.Processed,
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: false,
      },
      replayed: false,
    });
    const consumer = new WagerTransactionSqsConsumer(
      client,
      useCase,
      config,
    );

    await consumer.handleMessage(receivedMessage());

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'provider-1',
        externalTransactionId: 'transaction-1',
      }),
      'provider-1:transaction-1',
      expect.objectContaining({
        consumerName: config.consumerName,
        messageId: 'message-1',
        attempts: 1,
        payloadHash: expect.stringMatching(/^[a-f\d]{64}$/),
      }),
    );
    expect(deleteMessage).toHaveBeenCalledWith(config.queueUrl, 'receipt-1');
    expect(vi.mocked(execute).mock.invocationCallOrder[0]).toBeLessThan(
      deleteMessage.mock.invocationCallOrder[0],
    );
  });

  it('acknowledges terminal business errors without retrying', async () => {
    const {
      client,
      deleteMessage,
      changeMessageVisibility,
      sendToDeadLetterQueue,
    } = createQueueClient();
    const useCase = createUseCase();
    vi.spyOn(useCase, 'execute').mockRejectedValue(
      new AppError('Business rejection.', 'BUSINESS_REJECTION', 422),
    );
    const consumer = new WagerTransactionSqsConsumer(
      client,
      useCase,
      config,
    );

    await consumer.handleMessage(receivedMessage());

    expect(deleteMessage).toHaveBeenCalledWith(config.queueUrl, 'receipt-1');
    expect(changeMessageVisibility).not.toHaveBeenCalled();
    expect(sendToDeadLetterQueue).not.toHaveBeenCalled();
  });

  it('sends malformed messages to the FIFO DLQ before deleting the source', async () => {
    const { client, deleteMessage, sendToDeadLetterQueue } =
      createQueueClient();
    const consumer = new WagerTransactionSqsConsumer(
      client,
      createUseCase(),
      config,
    );

    await consumer.handleMessage(receivedMessage('{not-json'));

    expect(sendToDeadLetterQueue).toHaveBeenCalledWith(
      config.deadLetterQueueUrl,
      '{not-json',
      'provider-1',
      expect.stringMatching(/^[a-f\d]{64}$/),
    );
    expect(deleteMessage).toHaveBeenCalledWith(config.queueUrl, 'receipt-1');
    expect(sendToDeadLetterQueue.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMessage.mock.invocationCallOrder[0],
    );
  });

  it('uses exponential visibility backoff for transient failures', async () => {
    const { client, changeMessageVisibility, deleteMessage } =
      createQueueClient();
    const useCase = createUseCase();
    vi.spyOn(useCase, 'execute').mockRejectedValue(new Error('Database timeout.'));
    const consumer = new WagerTransactionSqsConsumer(
      client,
      useCase,
      config,
    );

    await consumer.handleMessage(receivedMessage(body, '2'));

    expect(changeMessageVisibility).toHaveBeenCalledWith(
      config.queueUrl,
      'receipt-1',
      2,
    );
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('moves transient failures to the DLQ at the attempt limit', async () => {
    const {
      client,
      sendToDeadLetterQueue,
      deleteMessage,
      changeMessageVisibility,
    } = createQueueClient();
    const useCase = createUseCase();
    vi.spyOn(useCase, 'execute').mockRejectedValue(new Error('Database timeout.'));
    const consumer = new WagerTransactionSqsConsumer(
      client,
      useCase,
      config,
    );

    await consumer.handleMessage(receivedMessage(body, '3'));

    expect(sendToDeadLetterQueue).toHaveBeenCalledOnce();
    expect(deleteMessage).toHaveBeenCalledWith(config.queueUrl, 'receipt-1');
    expect(changeMessageVisibility).not.toHaveBeenCalled();
  });

  it('aborts the long poll and waits for polling to stop on shutdown', async () => {
    const { client, receiveMessages } = createQueueClient();
    receiveMessages.mockImplementation(
      async (_queueUrl, _waitSeconds, _visibilitySeconds, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve([]), { once: true });
        }),
    );
    const consumer = new WagerTransactionSqsConsumer(
      client,
      createUseCase(),
      config,
    );

    consumer.onModuleInit();
    await consumer.onModuleDestroy();

    expect(receiveMessages).toHaveBeenCalledOnce();
    expect(receiveMessages.mock.calls[0][3].aborted).toBe(true);
  });

  it('requires both source and dead-letter queue URLs when enabled', () => {
    expect(() =>
      loadWagerTransactionSqsConsumerConfig({
        SQS_QUEUE_URL: config.queueUrl,
      }),
    ).toThrow('SQS_QUEUE_URL and SQS_DLQ_URL must both be configured');
  });
});
