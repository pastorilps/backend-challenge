import { EntityManager } from '@mikro-orm/postgresql';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutboxMessage } from '../../../../domain/outbox/entities/outbox-message.js';
import { OutboxMessageOrmEntity } from '../../../database/mikro-orm/entities/outbox-message.orm-entity.js';
import { SqsQueueClient } from '../sqs-queue-client.js';
import { ApplicationMetrics } from '../../../../application/observability/application-metrics.js';

export interface SqsOutboxPublisherConfig {
  queueUrl: string;
  batchSize: number;
  pollIntervalMs: number;
}

export function loadSqsOutboxPublisherConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SqsOutboxPublisherConfig | undefined {
  const queueUrl = environment.SQS_EVENTS_QUEUE_URL;
  if (!queueUrl) {
    return undefined;
  }
  return {
    queueUrl,
    batchSize: positiveInteger(
      environment.OUTBOX_BATCH_SIZE,
      10,
      'OUTBOX_BATCH_SIZE',
      10,
    ),
    pollIntervalMs: positiveInteger(
      environment.OUTBOX_POLL_INTERVAL_MS,
      1_000,
      'OUTBOX_POLL_INTERVAL_MS',
      60_000,
    ),
  };
}

export class SqsEventPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsEventPublisher.name);
  private readonly stopController = new AbortController();
  private stopping = false;
  private polling?: Promise<void>;

  constructor(
    private readonly entityManager: EntityManager,
    private readonly queueClient: SqsQueueClient,
    private readonly config?: SqsOutboxPublisherConfig,
    private readonly metrics?: ApplicationMetrics,
  ) {}

  onModuleInit(): void {
    if (!this.config) {
      this.logger.log(
        'Transactional outbox publisher is disabled; SQS_EVENTS_QUEUE_URL is not configured.',
      );
      return;
    }
    this.polling = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    await this.polling;
  }

  async publishDueBatch(now = new Date()): Promise<number> {
    const config = this.config;
    if (!config) {
      return 0;
    }
    return this.entityManager.transactional(async (transactionManager) => {
      const rows = (await transactionManager
        .getConnection()
        .execute(
          `select id
             from outbox_messages
            where status = 'PENDING'
              and (next_attempt_at is null or next_attempt_at <= ?)
            order by occurred_at asc, id asc
            limit ?
            for update skip locked`,
          [now, config.batchSize],
        )) as Array<{ id: string }>;

      let publishedCount = 0;
      for (const row of rows) {
        const entity = await transactionManager.findOne(
          OutboxMessageOrmEntity,
          { id: row.id },
        );
        if (!entity) {
          throw new Error(`Locked outbox message ${row.id} disappeared.`);
        }
        const message = OutboxMessage.rehydrate({
          id: entity.id,
          aggregateId: entity.aggregateId,
          eventType: entity.eventType,
          payload: entity.payloadJson,
          occurredAt: entity.occurredAt,
          attempts: entity.attempts,
          ...(entity.nextAttemptAt
            ? { nextAttemptAt: entity.nextAttemptAt }
            : {}),
          ...(entity.publishedAt ? { publishedAt: entity.publishedAt } : {}),
        });
        const eventId = message.payload.eventId;
        if (typeof eventId !== 'string' || eventId.length === 0) {
          throw new Error(
            `Outbox message ${message.id} has no valid integration event ID.`,
          );
        }

        try {
          await this.queueClient.publishEvent(
            config.queueUrl,
            JSON.stringify(message.payload),
            message.aggregateId,
            eventId,
          );
          message.markPublished(now);
          const publishedAt = message.publishedAt;
          if (!publishedAt) {
            throw new Error(
              `Outbox message ${message.id} was not marked as published.`,
            );
          }
          entity.status = 'PUBLISHED';
          entity.publishedAt = publishedAt;
          entity.nextAttemptAt = null;
          entity.attempts = message.attempts;
          publishedCount += 1;
          const lagMs = Math.max(
            0,
            now.getTime() - message.occurredAt.getTime(),
          );
          this.metrics?.observeOutboxLag(lagMs);
          this.logger.log(
            JSON.stringify({
              event: 'outbox_event_published',
              ...eventLogContext(message.payload, message.aggregateId),
              outboxMessageId: message.id,
              eventId,
              eventType: message.eventType,
              aggregateId: message.aggregateId,
              attempts: message.attempts,
              occurredAt: message.occurredAt.toISOString(),
              publishedAt: now.toISOString(),
              lagMs,
            }),
          );
        } catch (error) {
          message.scheduleRetry(now);
          const nextAttemptAt = message.nextAttemptAt;
          if (!nextAttemptAt) {
            throw new Error(
              `Outbox message ${message.id} has no scheduled retry time.`,
            );
          }
          entity.status = 'PENDING';
          entity.attempts = message.attempts;
          entity.nextAttemptAt = nextAttemptAt;
          this.metrics?.incrementRetry('outbox');
          this.logger.error(
            JSON.stringify({
              event: 'outbox_event_publish_failed',
              ...eventLogContext(message.payload, message.aggregateId),
              outboxMessageId: message.id,
              eventId,
              eventType: message.eventType,
              aggregateId: message.aggregateId,
              attempts: message.attempts,
              nextAttemptAt: message.nextAttemptAt?.toISOString(),
              errorName: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
      }
      await transactionManager.flush();
      return publishedCount;
    });
  }

  private async poll(): Promise<void> {
    if (!this.config) {
      return;
    }
    while (!this.stopping) {
      try {
        await this.publishDueBatch();
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'outbox_batch_failed',
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      }
      await delay(this.config.pollIntervalMs, this.stopController.signal);
    }
  }
}

function eventLogContext(
  payload: Readonly<Record<string, unknown>>,
  aggregateId: string,
): {
  correlationId: string | null;
  messageId: null;
  transactionId: string | null;
  walletId: string;
  providerId: string | null;
} {
  const data = payload.data;
  const eventData =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : {};
  return {
    correlationId:
      typeof payload.correlationId === 'string' ? payload.correlationId : null,
    messageId: null,
    transactionId:
      typeof eventData.transactionId === 'string'
        ? eventData.transactionId
        : null,
    walletId:
      typeof eventData.walletId === 'string' ? eventData.walletId : aggregateId,
    providerId:
      typeof eventData.providerId === 'string' ? eventData.providerId : null,
  };
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

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve();
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}