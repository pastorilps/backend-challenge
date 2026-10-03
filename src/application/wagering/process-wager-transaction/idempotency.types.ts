import { WagerTransactionOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wager-transaction.orm-entity.js';
import { MoneyProps } from '../../../domain/wallet/value-objects/money.js';
import { WagerTransactionKind } from '../../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/enums/wager-transaction-status.js';
import { EntityManager } from '@mikro-orm/core';

export interface ProcessWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode?: string;
  idempotentReplay: false;
}

export interface IdempotentOperationResult {
  transaction: WagerTransactionOrmEntity;
  response: WagerTransactionResponse;
}

export interface IdempotentExecutionResult {
  response: Omit<WagerTransactionResponse, 'idempotentReplay'> & {
    idempotentReplay: boolean;
  };
  replayed: boolean;
}

export interface WagerTransactionInboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  payloadJson: Readonly<Record<string, unknown>>;
  attempts: number;
}

export type WagerTransactionOperation = (
  transactionManager: EntityManager,
) => Promise<IdempotentOperationResult>;

export abstract class WagerTransactionIdempotencyExecutor {
  abstract execute(
    idempotencyKey: string,
    payloadHash: string,
    operation: WagerTransactionOperation,
    inboxReceipt?: WagerTransactionInboxReceipt,
  ): Promise<IdempotentExecutionResult>;
}
