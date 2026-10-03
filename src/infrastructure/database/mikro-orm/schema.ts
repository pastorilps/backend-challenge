import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  declare id: string;
  declare playerId: string;
  declare currency: string;
  declare balanceAmount: string;
  declare version: number;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare wagerTransactions: WagerTransactionRecord[];
  declare ledgerEntries: WalletLedgerEntryRecord[];
}

export class WagerTransactionRecord {
  declare id: string;
  declare providerId: string;
  declare externalTransactionId: string;
  declare idempotencyKey: string;
  declare payloadHash: string;
  declare wallet: WalletRecord;
  declare playerId: string;
  declare roundId: string | null;
  declare gameId: string | null;
  declare kind: string;
  declare moneyAmount: string;
  declare moneyCurrency: string;
  declare referenceExternalTransactionId: string | null;
  declare referenceTransaction: WagerTransactionRecord | null;
  declare reversals: WagerTransactionRecord[];
  declare status: string;
  declare failureCode: string | null;
  declare processedAt: Date | null;
  declare createdAt: Date;
  declare ledgerEntries: WalletLedgerEntryRecord[];
}

export class WalletLedgerEntryRecord {
  declare id: string;
  declare wallet: WalletRecord;
  declare transaction: WagerTransactionRecord;
  declare direction: string;
  declare amount: string;
  declare currency: string;
  declare balanceBeforeAmount: string;
  declare balanceAfterAmount: string;
  declare createdAt: Date;
}

export class InboxMessageRecord {
  declare id: string;
  declare consumerName: string;
  declare messageId: string;
  declare payloadHash: string;
  declare payloadJson: Record<string, unknown>;
  declare receivedAt: Date;
  declare processedAt: Date | null;
  declare attempts: number;
  declare nextAttemptAt: Date | null;
  declare status: string;
}

export class OutboxMessageRecord {
  declare id: string;
  declare aggregateId: string;
  declare eventType: string;
  declare payloadJson: Record<string, unknown>;
  declare occurredAt: Date;
  declare attempts: number;
  declare nextAttemptAt: Date | null;
  declare publishedAt: Date | null;
  declare status: string;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
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
      entity: () => WagerTransactionRecord,
      mappedBy: 'wallet',
    },
    ledgerEntries: {
      kind: '1:m',
      entity: () => WalletLedgerEntryRecord,
      mappedBy: 'wallet',
    },
  },
  uniques: [{ properties: ['playerId', 'currency'], name: 'wallets_player_currency_uq' }],
  indexes: [
    { properties: ['playerId'], name: 'wallets_player_id_idx' },
    { properties: ['updatedAt'], name: 'wallets_updated_at_idx' },
  ],
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
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
      entity: () => WalletRecord,
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
      entity: () => WagerTransactionRecord,
      inversedBy: 'reversals',
      joinColumn: 'reference_transaction_id',
      nullable: true,
    },
    reversals: {
      kind: '1:m',
      entity: () => WagerTransactionRecord,
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
    createdAt: {
      type: 'timestamptz',
      fieldName: 'created_at',
      defaultRaw: 'now()',
    },
    ledgerEntries: {
      kind: '1:m',
      entity: () => WalletLedgerEntryRecord,
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

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    wallet: {
      kind: 'm:1',
      entity: () => WalletRecord,
      inversedBy: 'ledgerEntries',
      joinColumn: 'wallet_id',
    },
    transaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
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

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
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
    { properties: ['status', 'nextAttemptAt'], name: 'inbox_messages_retry_idx' },
  ],
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
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
    { properties: ['status', 'nextAttemptAt'], name: 'outbox_messages_retry_idx' },
    { properties: ['aggregateId', 'eventType'], name: 'outbox_messages_aggregate_event_idx' },
  ],
});
