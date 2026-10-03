import { describe, expect, it, vi } from 'vitest';
import { GetWalletLedgerUseCase } from './get-wallet-ledger.use-case.js';
import { WalletLedgerEntryOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet-ledger-entry.orm-entity.js';
import { EntityManager } from '@mikro-orm/postgresql';

function entry(id: string, createdAt: Date): WalletLedgerEntryOrmEntity {
  return {
    id,
    wallet: { id: '00000000-0000-4000-8000-000000000001' },
    transaction: { id, kind: 'BET' },
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balanceBeforeAmount: '20.00',
    balanceAfterAmount: '10.00',
    createdAt,
  } as WalletLedgerEntryOrmEntity;
}

describe('GetWalletLedgerUseCase', () => {
  it('returns stable keyset pages and an opaque continuation cursor', async () => {
    const first = entry(
      '00000000-0000-4000-8000-000000000002',
      new Date('2026-01-01T00:00:00.000Z'),
    );
    const next = entry(
      '00000000-0000-4000-8000-000000000001',
      new Date('2025-12-31T23:59:59.000Z'),
    );
    const em = {
      findOne: vi.fn().mockResolvedValue({ id: first.wallet.id }),
      find: vi
        .fn()
        .mockResolvedValueOnce([first, next])
        .mockResolvedValueOnce([]),
    };
    const useCase = new GetWalletLedgerUseCase({
      fork: () => em,
    } as unknown as EntityManager);

    const firstPage = await useCase.execute(first.wallet.id, 1);
    const secondPage = await useCase.execute(
      first.wallet.id,
      1,
      firstPage.nextCursor ?? undefined,
    );

    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0].transactionId).toBe(first.id);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(secondPage.entries).toHaveLength(0);
    expect(em.find).toHaveBeenNthCalledWith(
      2,
      WalletLedgerEntryOrmEntity,
      {
        wallet: first.wallet.id,
        $or: [
          { createdAt: { $lt: first.createdAt } },
          { createdAt: first.createdAt, id: { $lt: first.id } },
        ],
      },
      {
        populate: ['transaction'],
        orderBy: { createdAt: 'DESC', id: 'DESC' },
        limit: 2,
      },
    );
  });

  it('rejects malformed cursors explicitly', async () => {
    const em = {
      findOne: vi.fn().mockResolvedValue({ id: 'wallet-1' }),
      find: vi.fn(),
    };
    const useCase = new GetWalletLedgerUseCase({
      fork: () => em,
    } as unknown as EntityManager);

    await expect(
      useCase.execute('wallet-1', 50, 'not-a-cursor'),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
    expect(em.find).not.toHaveBeenCalled();
  });
});
