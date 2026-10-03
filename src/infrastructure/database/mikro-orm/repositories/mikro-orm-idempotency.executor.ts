import { EntityManager } from '@mikro-orm/postgresql';
import { IdempotencyConflictError } from '../../../../domain/wagering/errors/idempotency-conflict.error.js';
import {
  IdempotentExecutionResult,
  WagerTransactionIdempotencyExecutor,
  WagerTransactionInboxReceipt,
  WagerTransactionOperation,
} from '../../../../application/wagering/process-wager-transaction/idempotency.types.js';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';
import { acquireTransactionAdvisoryLock } from './transaction-advisory-lock.js';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity.js';
import { AppError } from '../../../../shared/errors/app.error.js';
import { InboxPayloadConflictError } from '../../../../domain/inbox/errors/inbox-payload-conflict.error.js';
import { InboxMessageAlreadyProcessedError } from '../../../../domain/inbox/errors/inbox-message-already-processed.error.js';

export class MikroOrmIdempotencyExecutor extends WagerTransactionIdempotencyExecutor {
  constructor(private readonly entityManager: EntityManager) {
    super();
  }

  override async execute(
    idempotencyKey: string,
    payloadHash: string,
    operation: WagerTransactionOperation,
    inboxReceipt?: WagerTransactionInboxReceipt,
  ): Promise<IdempotentExecutionResult> {
    try {
      return await this.entityManager.transactional(async (transactionManager) => {
        let inboxEntity: InboxMessageOrmEntity | null = null;
        if (inboxReceipt) {
          await acquireTransactionAdvisoryLock(
            transactionManager,
            'sqs-inbox',
            inboxReceipt.consumerName,
            inboxReceipt.messageId,
          );
          inboxEntity = await transactionManager.findOne(
            InboxMessageOrmEntity,
            {
              consumerName: inboxReceipt.consumerName,
              messageId: inboxReceipt.messageId,
            },
          );
          if (
            inboxEntity &&
            inboxEntity.payloadHash !== inboxReceipt.payloadHash
          ) {
            throw new InboxPayloadConflictError();
          }
          if (inboxEntity?.status === 'FAILED') {
            throw new InboxMessageAlreadyProcessedError();
          }
          if (!inboxEntity) {
            inboxEntity = new InboxMessageOrmEntity();
            inboxEntity.consumerName = inboxReceipt.consumerName;
            inboxEntity.messageId = inboxReceipt.messageId;
            inboxEntity.payloadHash = inboxReceipt.payloadHash;
            inboxEntity.payloadJson = structuredClone(
              inboxReceipt.payloadJson,
            );
            inboxEntity.receivedAt = new Date();
            inboxEntity.processedAt = null;
            inboxEntity.attempts = inboxReceipt.attempts;
            inboxEntity.nextAttemptAt = null;
            inboxEntity.status = 'RECEIVED';
            transactionManager.persist(inboxEntity);
          }
        }

        await acquireTransactionAdvisoryLock(
          transactionManager,
          'idempotency',
          idempotencyKey,
        );

        const existing = await transactionManager.findOne(
          WagerTransactionOrmEntity,
          { idempotencyKey },
        );

        let executionResult: IdempotentExecutionResult;
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new IdempotencyConflictError();
          }
          if (!existing.idempotencyResponse) {
            throw new Error(
              `Transaction ${existing.id} has no persisted idempotency response.`,
            );
          }
          executionResult = {
            response: {
              ...existing.idempotencyResponse,
              idempotentReplay: true,
            },
            replayed: true,
          };
        } else {
          const result = await operation(transactionManager);
          if (
            result.transaction.idempotencyKey !== idempotencyKey ||
            result.transaction.payloadHash !== payloadHash
          ) {
            throw new Error(
              'Operation transaction does not match its idempotency key and payload hash.',
            );
          }
          if (
            result.response.transactionId !== result.transaction.id ||
            result.response.idempotentReplay
          ) {
            throw new Error(
              'Operation response must refer to its transaction and be marked as a first execution.',
            );
          }

          result.transaction.idempotencyResponse = result.response;
          transactionManager.persist(result.transaction);
          executionResult = {
            response: result.response,
            replayed: false,
          };
        }

        if (inboxEntity) {
          inboxEntity.status = 'PROCESSED';
          inboxEntity.processedAt ??= new Date();
          transactionManager.persist(inboxEntity);
        }
        await transactionManager.flush();
        return executionResult;
      });
    } catch (error) {
      if (
        inboxReceipt &&
        error instanceof AppError &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        !(error instanceof InboxPayloadConflictError)
      ) {
        await this.recordTerminalInboxMessage(inboxReceipt);
      }
      throw error;
    }
  }

  private async recordTerminalInboxMessage(
    receipt: WagerTransactionInboxReceipt,
  ): Promise<void> {
    await this.entityManager.transactional(async (transactionManager) => {
      await acquireTransactionAdvisoryLock(
        transactionManager,
        'sqs-inbox',
        receipt.consumerName,
        receipt.messageId,
      );
      let inboxEntity = await transactionManager.findOne(
        InboxMessageOrmEntity,
        {
          consumerName: receipt.consumerName,
          messageId: receipt.messageId,
        },
      );
      if (
        inboxEntity &&
        inboxEntity.payloadHash !== receipt.payloadHash
      ) {
        throw new InboxPayloadConflictError();
      }
      if (!inboxEntity) {
        inboxEntity = new InboxMessageOrmEntity();
        inboxEntity.consumerName = receipt.consumerName;
        inboxEntity.messageId = receipt.messageId;
        inboxEntity.payloadHash = receipt.payloadHash;
        inboxEntity.payloadJson = structuredClone(receipt.payloadJson);
        inboxEntity.receivedAt = new Date();
        inboxEntity.processedAt = null;
        inboxEntity.attempts = receipt.attempts;
        inboxEntity.nextAttemptAt = null;
        inboxEntity.status = 'RECEIVED';
      }
      if (
        inboxEntity.status !== 'PROCESSED' &&
        inboxEntity.status !== 'FAILED'
      ) {
        inboxEntity.status = 'FAILED';
        inboxEntity.processedAt = new Date();
        inboxEntity.nextAttemptAt = null;
      }
      transactionManager.persist(inboxEntity);
      await transactionManager.flush();
    });
  }
}
