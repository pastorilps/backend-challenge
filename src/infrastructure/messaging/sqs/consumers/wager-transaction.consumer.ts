import { createHash } from 'node:crypto';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsDateString,
  IsString,
  Length,
  ValidateNested,
  validate,
} from 'class-validator';
import { AppError } from '../../../../shared/errors/app.error.js';
import { InboxMessageAlreadyProcessedError } from '../../../../domain/inbox/errors/inbox-message-already-processed.error.js';
import { InboxPayloadConflictError } from '../../../../domain/inbox/errors/inbox-payload-conflict.error.js';
import { ProcessWagerTransactionUseCase } from '../../../../application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import { CreateWagerTransactionDto } from '../../../../presentation/http/wagering/dto/create-wager-transaction.dto.js';
import { ApplicationMetrics } from '../../../../application/observability/application-metrics.js';
import {
  SqsQueueClient,
  SqsReceivedMessage,
} from '../sqs-queue-client.js';

class SqsWagerTransactionDataDto extends CreateWagerTransactionDto {
  @IsString()
  @Length(1, 255)
  idempotencyKey!: string;
}

class WagerTransactionRequestedDto {
  @IsString()
  @Length(1, 255)
  messageId!: string;

  @IsString()
  @Length(1, 100)
  type!: string;

  @IsDateString()
  occurredAt!: string;

  @ValidateNested()
  @Type(() => SqsWagerTransactionDataDto)
  data!: SqsWagerTransactionDataDto;
}

export interface WagerTransactionSqsConsumerConfig {
  queueUrl: string;
  deadLetterQueueUrl: string;
  consumerName: string;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
}

export function loadWagerTransactionSqsConsumerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WagerTransactionSqsConsumerConfig | undefined {
  const queueUrl = environment.SQS_QUEUE_URL;
  const deadLetterQueueUrl = environment.SQS_DLQ_URL;
  if (!queueUrl && !deadLetterQueueUrl) {
    return undefined;
  }
  if (!queueUrl || !deadLetterQueueUrl) {
    throw new Error(
      'SQS_QUEUE_URL and SQS_DLQ_URL must both be configured to enable the wager consumer.',
    );
  }
  const consumerName =
    environment.SQS_CONSUMER_NAME ?? 'wager-transaction-consumer';
  if (consumerName.trim().length === 0 || consumerName.length > 100) {
    throw new Error('SQS_CONSUMER_NAME must contain from 1 to 100 characters.');
  }

  return {
    queueUrl,
    deadLetterQueueUrl,
    consumerName,
    maxAttempts: positiveInteger(
      environment.SQS_MAX_ATTEMPTS,
      5,
      'SQS_MAX_ATTEMPTS',
      100,
    ),
    retryBaseDelayMs: positiveInteger(
      environment.SQS_RETRY_BASE_DELAY_MS,
      1_000,
      'SQS_RETRY_BASE_DELAY_MS',
      43_200_000,
    ),
    retryMaxDelayMs: positiveInteger(
      environment.SQS_RETRY_MAX_DELAY_MS,
      300_000,
      'SQS_RETRY_MAX_DELAY_MS',
      43_200_000,
    ),
    visibilityTimeoutSeconds: positiveInteger(
      environment.SQS_VISIBILITY_TIMEOUT_SECONDS,
      60,
      'SQS_VISIBILITY_TIMEOUT_SECONDS',
      43_200,
    ),
    waitTimeSeconds: positiveInteger(
      environment.SQS_WAIT_TIME_SECONDS,
      20,
      'SQS_WAIT_TIME_SECONDS',
      20,
    ),
  };
}

export class SqsMessageValidationError extends Error {
  constructor() {
    super('SQS message does not match WagerTransactionRequested.');
    this.name = new.target.name;
  }
}

export class WagerTransactionSqsConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WagerTransactionSqsConsumer.name);
  private readonly abortController = new AbortController();
  private stopping = false;
  private polling?: Promise<void>;

  constructor(
    private readonly queueClient: SqsQueueClient,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly config?: WagerTransactionSqsConsumerConfig,
    private readonly metrics?: ApplicationMetrics,
  ) {}

  onModuleInit(): void {
    if (!this.config) {
      this.logger.log(
        'SQS wager consumer is disabled; queue URLs are not configured.',
      );
      return;
    }
    this.polling = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abortController.abort();
    await this.polling;
  }

  async handleMessage(message: SqsReceivedMessage): Promise<void> {
    if (!this.config) {
      throw new Error(
        'Cannot process an SQS message without consumer configuration.',
      );
    }
    if (!message.receiptHandle) {
      throw new Error('Received SQS message without a receipt handle.');
    }

    let messageContext = {
      messageId: message.messageId ?? null,
      correlationId: message.messageId ?? null,
      transactionId: null as string | null,
      walletId: null as string | null,
      providerId: null as string | null,
    };
    try {
      const envelope = await this.parseMessage(message.body);
      messageContext = {
        messageId: envelope.messageId,
        correlationId: envelope.messageId,
        transactionId: null,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      };
      const payloadHash = createHash('sha256')
        .update(message.body ?? '', 'utf8')
        .digest('hex');
      const receiveCount = this.receiveCount(message);
      const result = await this.processWagerTransaction.execute(
        envelope.data,
        envelope.data.idempotencyKey,
        {
          consumerName: this.config.consumerName,
          messageId: envelope.messageId,
          correlationId: envelope.messageId,
          payloadHash,
          payloadJson: envelope.raw,
          attempts: receiveCount,
        },
      );
      await this.queueClient.deleteMessage(
        this.config.queueUrl,
        message.receiptHandle,
      );
      this.logger.log(
        JSON.stringify({
          event: 'sqs_wager_message_acknowledged',
          ...messageContext,
          transactionId: result.response.transactionId,
          receiveCount,
        }),
      );
    } catch (error) {
      if (
        error instanceof SqsMessageValidationError ||
        error instanceof InboxPayloadConflictError
      ) {
        await this.moveToDeadLetterQueue(message, messageContext);
        return;
      }
      if (error instanceof InboxMessageAlreadyProcessedError) {
        await this.queueClient.deleteMessage(
          this.config.queueUrl,
          message.receiptHandle,
        );
        return;
      }
      if (
        error instanceof AppError &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      ) {
        await this.queueClient.deleteMessage(
          this.config.queueUrl,
          message.receiptHandle,
        );
        this.logger.warn(
          JSON.stringify({
            event: 'sqs_wager_business_error_acknowledged',
            ...messageContext,
            code: error.code,
          }),
        );
        return;
      }

      const receiveCount = this.receiveCount(message);
      if (receiveCount >= this.config.maxAttempts) {
        await this.moveToDeadLetterQueue(message, messageContext);
        return;
      }
      const delayMs = Math.min(
        this.config.retryBaseDelayMs * 2 ** Math.min(receiveCount - 1, 30),
        this.config.retryMaxDelayMs,
      );
      const visibilityTimeoutSeconds = this.stopping
        ? 0
        : Math.min(43_200, Math.max(1, Math.ceil(delayMs / 1_000)));
      await this.queueClient.changeMessageVisibility(
        this.config.queueUrl,
        message.receiptHandle,
        visibilityTimeoutSeconds,
      );
      this.metrics?.incrementRetry('sqs');
      this.logger.error(
        JSON.stringify({
          event: 'sqs_wager_transient_error_scheduled',
          ...messageContext,
          receiveCount,
          visibilityTimeoutSeconds,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  }

  private async poll(): Promise<void> {
    if (!this.config) {
      return;
    }
    while (!this.stopping) {
      let messages: SqsReceivedMessage[];
      try {
        messages = await this.queueClient.receiveMessages(
          this.config.queueUrl,
          this.config.waitTimeSeconds,
          this.config.visibilityTimeoutSeconds,
          this.abortController.signal,
        );
      } catch (error) {
        if (this.stopping) {
          return;
        }
        this.logger.error(
          JSON.stringify({
            event: 'sqs_receive_failed',
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        await delay(1_000);
        continue;
      }

      for (const message of messages) {
        if (this.stopping) {
          if (message.receiptHandle) {
            await this.queueClient.changeMessageVisibility(
              this.config.queueUrl,
              message.receiptHandle,
              0,
            );
          }
          break;
        }
        try {
          await this.handleMessage(message);
        } catch (error) {
          this.logger.error(
            JSON.stringify({
              event: 'sqs_message_handling_failed',
              messageId: message.messageId,
              errorName: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
      }
    }
  }

  private async parseMessage(
    body: string | undefined,
  ): Promise<{
    messageId: string;
    data: SqsWagerTransactionDataDto;
    raw: Readonly<Record<string, unknown>>;
  }> {
    let raw: unknown;
    try {
      raw = JSON.parse(body ?? '');
    } catch {
      throw new SqsMessageValidationError();
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SqsMessageValidationError();
    }
    const envelope = plainToInstance(WagerTransactionRequestedDto, raw);
    const errors = await validate(envelope, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0 || envelope.type !== 'WagerTransactionRequested') {
      throw new SqsMessageValidationError();
    }
    return {
      messageId: envelope.messageId,
      data: envelope.data,
      raw: raw as Readonly<Record<string, unknown>>,
    };
  }

  private receiveCount(message: SqsReceivedMessage): number {
    const count = Number(message.approximateReceiveCount ?? 1);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(
        'SQS ApproximateReceiveCount must be a positive integer.',
      );
    }
    return count;
  }

  private async moveToDeadLetterQueue(
    message: SqsReceivedMessage,
    context = {
      messageId: message.messageId ?? null,
      correlationId: message.messageId ?? null,
      transactionId: null as string | null,
      walletId: null as string | null,
      providerId: null as string | null,
    },
  ): Promise<void> {
    if (!this.config || !message.receiptHandle) {
      throw new Error(
        'Cannot move SQS message to DLQ without its receipt handle.',
      );
    }
    const body = message.body ?? '';
    const deduplicationId = createHash('sha256')
      .update(message.messageId ?? body, 'utf8')
      .digest('hex');
    await this.queueClient.sendToDeadLetterQueue(
      this.config.deadLetterQueueUrl,
      body,
      message.messageGroupId ?? 'wager-transactions',
      deduplicationId,
    );
    this.metrics?.incrementDeadLetterCount();
    await this.queueClient.deleteMessage(
      this.config.queueUrl,
      message.receiptHandle,
    );
    this.logger.warn(
      JSON.stringify({
        event: 'sqs_wager_message_sent_to_dlq',
        ...context,
        receiveCount: message.approximateReceiveCount,
      }),
    );
  }
}

function positiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}