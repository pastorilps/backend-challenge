import { EntityManager } from '@mikro-orm/postgresql';
import { AppError } from '../../../shared/errors/app.error.js';
import { WalletLedgerEntryOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet-ledger-entry.orm-entity.js';
import { WalletOrmEntity } from '../../../infrastructure/database/mikro-orm/entities/wallet.orm-entity.js';

export interface WalletLedgerEntryView {
  id: string;
  transactionId: string;
  kind: string;
  direction: string;
  amount: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  createdAt: string;
}

export interface WalletLedgerPage {
  walletId: string;
  entries: WalletLedgerEntryView[];
  nextCursor: string | null;
  limit: number;
}

interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export class GetWalletLedgerUseCase {
  constructor(private readonly entityManager: EntityManager) {}

  async execute(
    walletId: string,
    limit: number,
    cursorValue?: string,
  ): Promise<WalletLedgerPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError('Limit must be between 1 and 100.', 'INVALID_PAYLOAD');
    }

    const em = this.entityManager.fork();
    const walletExists = await em.findOne(WalletOrmEntity, { id: walletId });
    if (!walletExists) {
      throw new AppError('Wallet was not found.', 'WALLET_NOT_FOUND', 404);
    }

    const cursor = cursorValue ? this.decodeCursor(cursorValue) : undefined;
    const where = cursor
      ? {
          wallet: walletId,
          $or: [
            { createdAt: { $lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { $lt: cursor.id } },
          ],
        }
      : { wallet: walletId };
    const rows = await em.find(WalletLedgerEntryOrmEntity, where, {
      populate: ['transaction'],
      orderBy: { createdAt: 'DESC', id: 'DESC' },
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastEntry = pageRows.at(-1);

    return {
      walletId,
      entries: pageRows.map((entry) => ({
        id: entry.id,
        transactionId: entry.transaction.id,
        kind: entry.transaction.kind,
        direction: entry.direction,
        amount: { amount: entry.amount, currency: entry.currency },
        balanceBefore: {
          amount: entry.balanceBeforeAmount,
          currency: entry.currency,
        },
        balanceAfter: {
          amount: entry.balanceAfterAmount,
          currency: entry.currency,
        },
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor:
        hasMore && lastEntry
          ? this.encodeCursor({
              createdAt: lastEntry.createdAt,
              id: lastEntry.id,
            })
          : null,
      limit,
    };
  }

  private encodeCursor(cursor: LedgerCursor): string {
    return Buffer.from(
      JSON.stringify([cursor.createdAt.toISOString(), cursor.id]),
    ).toString('base64url');
  }

  private decodeCursor(value: string): LedgerCursor {
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const parsed: unknown = JSON.parse(decoded);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'string' ||
        typeof parsed[1] !== 'string'
      ) {
        throw new Error('Invalid cursor tuple.');
      }
      const createdAt = new Date(parsed[0]);
      if (
        Number.isNaN(createdAt.getTime()) ||
        createdAt.toISOString() !== parsed[0] ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          parsed[1],
        )
      ) {
        throw new Error('Invalid cursor values.');
      }
      return { createdAt, id: parsed[1] };
    } catch (error) {
      throw new AppError('Ledger cursor is invalid.', 'INVALID_CURSOR', 400, {
        cause: error,
      });
    }
  }
}
