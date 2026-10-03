import { EntitySchema } from '@mikro-orm/core';
import { InboxMessageOrmEntity } from './entities/inbox-message.orm-entity.js';
import { OutboxMessageOrmEntity } from './entities/outbox-message.orm-entity.js';
import { WagerTransactionOrmEntity } from './entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from './entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from './entities/wallet.orm-entity.js';

export const WalletSchema = new EntitySchema<WalletOrmEntity>({
  class: WalletOrmEntity,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    playerId: { type: 'varchar', fieldName: 'player_id', length: 255 },
    currency: { type: 'varchar', length: 3, check: "currency = 'BRL'" },
    balanceAmount: {
      type: 'numeric',
      fieldName: 'balance_amount',
      precision: 19,
      scale: 2,
      check: 'balance_amount >= 0',
    },
    version: { type: 'integer', default: 1, check: 'version >= 1' },
    createdAt: {
      type: 'timestamptz',
      fieldName: 'created_at',
      defaultRaw: 'now()',
    },
    updatedAt: {
      type: 'timestamptz',
      fieldName: 'updated_at',
      defaultRaw: 'now()',
    },
    wagerTransactions: {
      kind: '1:m',
      entity: () => WagerTransactionOrmEntity,
      mappedBy: 'wallet',
    },
    ledgerEntries: {
      kind: '1:m',
      entity: () => WalletLedgerEntryOrmEntity,
      mappedBy: 'wallet',
    },
  },
  uniques: [
    {
      properties: ['playerId', 'currency'],
      name: 'wallets_player_currency_uq',
    },
  ],
  indexes: [
    { properties: ['playerId'], name: 'wallets_player_id_idx' },
    { properties: ['updatedAt'], name: 'wallets_updated_at_idx' },
  ],
});

export const WagerTransactionSchema =
  new EntitySchema<WagerTransactionOrmEntity>({
    class: WagerTransactionOrmEntity,
    tableName: 'wager_transactions',
    properties: {
      id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
      providerId: { type: 'varchar', fieldName: 'provider_id', length: 100 },
      externalTransactionId: {
        type: 'varchar',
        fieldName: 'external_transaction_id',
        length: 255,
      },
      idempotencyKey: {
        type: 'varchar',
        fieldName: 'idempotency_key',
        length: 255,
      },
      payloadHash: {
        type: 'varchar',
        fieldName: 'payload_hash',
        length: 64,
      },
      wallet: {
        kind: 'm:1',
        entity: () => WalletOrmEntity,
        inversedBy: 'wagerTransactions',
        joinColumn: 'wallet_id',
      },
      playerId: { type: 'varchar', fieldName: 'player_id', length: 255 },
      roundId: {
        type: 'varchar',
        fieldName: 'round_id',
        length: 255,
        nullable: true,
      },
      gameId: {
        type: 'varchar',
        fieldName: 'game_id',
        length: 255,
        nullable: true,
      },
      kind: { type: 'varchar', length: 32 },
      moneyAmount: {
        type: 'numeric',
        fieldName: 'money_amount',
        precision: 19,
        scale: 2,
        check: 'money_amount >= 0',
      },
      moneyCurrency: {
        type: 'varchar',
        fieldName: 'money_currency',
        length: 3,
        check: "money_currency = 'BRL'",
      },
      referenceExternalTransactionId: {
        type: 'varchar',
        fieldName: 'reference_external_transaction_id',
        length: 255,
        nullable: true,
      },
      referenceTransaction: {
        kind: 'm:1',
        entity: () => WagerTransactionOrmEntity,
        inversedBy: 'reversals',
        joinColumn: 'reference_transaction_id',
        nullable: true,
      },
      reversals: {
        kind: '1:m',
        entity: () => WagerTransactionOrmEntity,
        mappedBy: 'referenceTransaction',
      },
      status: { type: 'varchar', length: 32 },
      failureCode: {
        type: 'varchar',
        fieldName: 'failure_code',
        length: 64,
        nullable: true,
      },
      processedAt: {
        type: 'timestamptz',
        fieldName: 'processed_at',
        nullable: true,
      },
      idempotencyResponse: {
        type: 'json',
        columnType: 'jsonb',
        fieldName: 'idempotency_response',
        nullable: true,
      },
      createdAt: {
        type: 'timestamptz',
        fieldName: 'created_at',
        defaultRaw: 'now()',
      },
      ledgerEntries: {
        kind: '1:m',
        entity: () => WalletLedgerEntryOrmEntity,
        mappedBy: 'transaction',
      },
    },
    uniques: [
      {
        properties: ['idempotencyKey'],
        name: 'wager_transactions_idempotency_key_uq',
      },
      {
        properties: ['providerId', 'externalTransactionId'],
        name: 'wager_transactions_provider_external_id_uq',
      },
    ],
    indexes: [
      {
        properties: ['wallet', 'status'],
        name: 'wager_transactions_wallet_status_idx',
      },
      {
        properties: ['providerId', 'referenceExternalTransactionId'],
        name: 'wager_transactions_provider_reference_idx',
      },
      {
        properties: ['roundId', 'playerId', 'wallet'],
        name: 'wager_transactions_round_player_wallet_idx',
      },
    ],
  });

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryOrmEntity>({
    class: WalletLedgerEntryOrmEntity,
    tableName: 'wallet_ledger_entries',
    properties: {
      id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
      wallet: {
        kind: 'm:1',
        entity: () => WalletOrmEntity,
        inversedBy: 'ledgerEntries',
        joinColumn: 'wallet_id',
      },
      transaction: {
        kind: 'm:1',
        entity: () => WagerTransactionOrmEntity,
        inversedBy: 'ledgerEntries',
        joinColumn: 'transaction_id',
      },
      direction: { type: 'varchar', length: 16 },
      amount: {
        type: 'numeric',
        precision: 19,
        scale: 2,
        check: 'amount >= 0',
      },
      currency: { type: 'varchar', length: 3, check: "currency = 'BRL'" },
      balanceBeforeAmount: {
        type: 'numeric',
        fieldName: 'balance_before_amount',
        precision: 19,
        scale: 2,
        check: 'balance_before_amount >= 0',
      },
      balanceAfterAmount: {
        type: 'numeric',
        fieldName: 'balance_after_amount',
        precision: 19,
        scale: 2,
        check:
          "balance_after_amount >= 0 AND balance_after_amount = CASE WHEN direction = 'CREDIT' THEN balance_before_amount + amount WHEN direction = 'DEBIT' THEN balance_before_amount - amount END",
      },
      createdAt: {
        type: 'timestamptz',
        fieldName: 'created_at',
        defaultRaw: 'now()',
      },
    },
    uniques: [
      {
        properties: ['transaction', 'wallet'],
        name: 'wallet_ledger_entries_transaction_wallet_uq',
      },
    ],
    indexes: [
      {
        properties: ['wallet', 'createdAt'],
        name: 'wallet_ledger_entries_wallet_created_at_idx',
      },
    ],
    checks: [
      {
        name: 'wallet_ledger_entries_direction_chk',
        expression: "direction IN ('CREDIT', 'DEBIT')",
      },
    ],
  });

export const InboxMessageSchema = new EntitySchema<InboxMessageOrmEntity>({
  class: InboxMessageOrmEntity,
  tableName: 'inbox_messages',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    consumerName: {
      type: 'varchar',
      fieldName: 'consumer_name',
      length: 100,
    },
    messageId: { type: 'varchar', fieldName: 'message_id', length: 255 },
    payloadHash: {
      type: 'varchar',
      fieldName: 'payload_hash',
      length: 64,
    },
    payloadJson: {
      type: 'json',
      columnType: 'jsonb',
      fieldName: 'payload_json',
    },
    receivedAt: {
      type: 'timestamptz',
      fieldName: 'received_at',
      defaultRaw: 'now()',
    },
    processedAt: {
      type: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
    attempts: { type: 'integer', default: 0, check: 'attempts >= 0' },
    nextAttemptAt: {
      type: 'timestamptz',
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    status: { type: 'varchar', length: 32 },
  },
  uniques: [
    {
      properties: ['consumerName', 'messageId'],
      name: 'inbox_messages_consumer_message_id_uq',
    },
  ],
  indexes: [
    {
      properties: ['status', 'nextAttemptAt'],
      name: 'inbox_messages_retry_idx',
    },
  ],
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageOrmEntity>({
  class: OutboxMessageOrmEntity,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'varchar', fieldName: 'event_type', length: 100 },
    payloadJson: {
      type: 'json',
      columnType: 'jsonb',
      fieldName: 'payload_json',
    },
    occurredAt: {
      type: 'timestamptz',
      fieldName: 'occurred_at',
      defaultRaw: 'now()',
    },
    attempts: { type: 'integer', default: 0, check: 'attempts >= 0' },
    nextAttemptAt: {
      type: 'timestamptz',
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    publishedAt: {
      type: 'timestamptz',
      fieldName: 'published_at',
      nullable: true,
    },
    status: { type: 'varchar', length: 32 },
  },
  indexes: [
    {
      properties: ['status', 'nextAttemptAt'],
      name: 'outbox_messages_retry_idx',
    },
    {
      properties: ['aggregateId', 'eventType'],
      name: 'outbox_messages_aggregate_event_idx',
    },
  ],
});
