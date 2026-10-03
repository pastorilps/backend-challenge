import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessWagerTransactionUseCase } from '../../../../application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
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
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../entities/wallet.orm-entity.js';

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
  let orm: MikroORM;
  let useCase: ProcessWagerTransactionUseCase;
  const walletIds: string[] = [];

  beforeAll(async () => {
    orm = await MikroORM.init({
      clientUrl: getTestDatabaseUrl(),
      entities: [
        WalletSchema,
        WagerTransactionSchema,
        WalletLedgerEntrySchema,
        InboxMessageSchema,
        OutboxMessageSchema,
      ],
    });
    useCase = new ProcessWagerTransactionUseCase(
      new MikroOrmIdempotencyExecutor(orm.em),
      new MikroOrmWagerTransactionProcessor(),
    );
  });

  afterAll(async () => {
    if (!orm) {
      return;
    }
    const em = orm.em.fork();
    if (walletIds.length > 0) {
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
    await orm.close(true);
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
    const em = orm.em.fork();
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

  it('applies 50 deliveries of the same wager once and replays the original response', async () => {
    const walletId = await createWallet('100.00');
    const payload = request(walletId, `same-${randomUUID()}`, '1.00');
    const wallet = await orm.em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    payload.playerId = wallet.playerId;
    const key = `parallel-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCase.execute(payload, key)),
    );
    const persistedWallet = await orm.em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const entryCount = await orm.em.fork().count(WalletLedgerEntryOrmEntity, {
      wallet: walletId,
    });

    expect(
      results.filter((result) => result.response.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.response.idempotentReplay === true),
    ).toHaveLength(49);
    expect(persistedWallet.balanceAmount).toBe('99.00');
    expect(entryCount).toBe(1);
  });

  it('allows only one of two concurrent 80.00 bets against a 100.00 wallet', async () => {
    const walletId = await createWallet('100.00');
    const wallet = await orm.em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const bets = [
      request(walletId, `bet-a-${randomUUID()}`, '80.00'),
      request(walletId, `bet-b-${randomUUID()}`, '80.00'),
    ].map((input) => ({ ...input, playerId: wallet.playerId }));

    const results = await Promise.all(
      bets.map((input) =>
        useCase.execute(input, `key-${input.externalTransactionId}`),
      ),
    );
    const persistedWallet = await orm.em
      .fork()
      .findOneOrFail(WalletOrmEntity, { id: walletId });
    const entryCount = await orm.em.fork().count(WalletLedgerEntryOrmEntity, {
      wallet: walletId,
    });

    expect(
      results.filter(
        (result) => result.response.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.response.status === WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(1);
    expect(persistedWallet.balanceAmount).toBe('20.00');
    expect(entryCount).toBe(1);
  });
});
