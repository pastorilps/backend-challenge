import { EntityManager } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { LockMode } from '@mikro-orm/core';
import { WalletLedgerEntryOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet.orm-entity.js';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case.js';

function setup(balanceAmount: string) {
  const wallet = {
    id: 'wallet-1',
    currency: 'BRL',
    balanceAmount,
  };
  const ledger: WalletLedgerEntryOrmEntity[] = [
    {
      id: 'entry-1',
      wallet: { id: 'wallet-1' },
      transaction: { id: 'transaction-1' },
      direction: 'CREDIT',
      amount: '100.00',
      currency: 'BRL',
      balanceBeforeAmount: '0.00',
      balanceAfterAmount: '100.00',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    } as WalletLedgerEntryOrmEntity,
    {
      id: 'entry-2',
      wallet: { id: 'wallet-1' },
      transaction: { id: 'transaction-2' },
      direction: 'DEBIT',
      amount: '10.00',
      currency: 'BRL',
      balanceBeforeAmount: '100.00',
      balanceAfterAmount: '90.00',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    } as WalletLedgerEntryOrmEntity,
  ];
  const em = {
    findOne: vi.fn().mockResolvedValue(wallet),
    find: vi.fn().mockResolvedValue(ledger),
  };
  const entityManager = {
    transactional: vi.fn(
      async <Result>(callback: (manager: typeof em) => Promise<Result>) =>
        callback(em),
    ),
  };
  const metrics = { incrementMismatchCount: vi.fn() };
  return {
    useCase: new ReconcileWalletUseCase(
      entityManager as unknown as EntityManager,
      metrics,
    ),
    wallet,
    em,
    entityManager,
    metrics,
  };
}

describe('ReconcileWalletUseCase', () => {
  it('returns matching calculated and stored balances without changing the wallet', async () => {
    const state = setup('90.00');

    await expect(state.useCase.execute('wallet-1')).resolves.toEqual({
      walletId: 'wallet-1',
      storedBalance: { amount: '90.00', currency: 'BRL' },
      calculatedBalance: { amount: '90.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
    expect(state.em.findOne).toHaveBeenCalledWith(
      WalletOrmEntity,
      { id: 'wallet-1' },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    expect(state.wallet.balanceAmount).toBe('90.00');
  });

  it('reports and logs mismatches without silently correcting the wallet', async () => {
    const state = setup('95.00');
    const logError = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});

    try {
      const result = await state.useCase.execute('wallet-1');
      expect(result).toMatchObject({
        storedBalance: { amount: '95.00', currency: 'BRL' },
        calculatedBalance: { amount: '90.00', currency: 'BRL' },
        difference: { amount: '5.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 2,
      });
      expect(logError).toHaveBeenCalledOnce();
      expect(state.metrics.incrementMismatchCount).toHaveBeenCalledOnce();
      expect(state.wallet.balanceAmount).toBe('95.00');
    } finally {
      logError.mockRestore();
    }
  });

  it('returns not found when the wallet does not exist', async () => {
    const state = setup('0.00');
    state.em.findOne.mockResolvedValue(null);

    await expect(state.useCase.execute('missing-wallet')).rejects.toMatchObject(
      {
        code: 'WALLET_NOT_FOUND',
        statusCode: 404,
      },
    );
    expect(state.em.find).not.toHaveBeenCalled();
  });
});
