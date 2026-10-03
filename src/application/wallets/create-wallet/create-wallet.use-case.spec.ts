import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet.orm-entity.js';
import { CreateWalletUseCase } from './create-wallet.use-case.js';

function createUseCase() {
  const persisted: object[] = [];
  const em = {
    persist: vi.fn((entities: object | object[]) => {
      persisted.push(...(Array.isArray(entities) ? entities : [entities]));
    }),
  };
  const orm = {
    em: {
      transactional: vi.fn(
        async <Result>(callback: (manager: typeof em) => Promise<Result>) =>
          callback(em),
      ),
    },
  };
  return {
    useCase: new CreateWalletUseCase(orm as never),
    orm,
    persisted,
  };
}

describe('CreateWalletUseCase', () => {
  it('creates the wallet and opening credit in one transaction', async () => {
    const { useCase, orm, persisted } = createUseCase();

    const result = await useCase.execute({
      playerId: 'player-1',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    const wallet = persisted.find(
      (entity) => entity instanceof WalletOrmEntity,
    ) as WalletOrmEntity;
    const transaction = persisted.find(
      (entity) => entity instanceof WagerTransactionOrmEntity,
    ) as WagerTransactionOrmEntity;
    const ledger = persisted.find(
      (entity) => entity instanceof WalletLedgerEntryOrmEntity,
    ) as WalletLedgerEntryOrmEntity;

    expect(orm.em.transactional).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      playerId: 'player-1',
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(wallet.balanceAmount).toBe('1000.00');
    expect(transaction).toMatchObject({
      providerId: 'internal',
      kind: 'OPENING',
      status: 'PROCESSED',
      moneyAmount: '1000.00',
    });
    expect(ledger).toMatchObject({
      direction: 'CREDIT',
      amount: '1000.00',
      balanceBeforeAmount: '0.00',
      balanceAfterAmount: '1000.00',
      transaction,
      wallet,
    });
  });

  it('does not create an opening transaction or ledger for a zero balance', async () => {
    const { useCase, persisted } = createUseCase();

    const result = await useCase.execute({
      playerId: 'player-1',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(result.balance.amount).toBe('0.00');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBeInstanceOf(WalletOrmEntity);
  });
});
