import { describe, expect, it } from 'vitest';
import { LedgerDirection } from '../../ledger/enums/ledger-direction.js';
import { Money } from '../../wallet/value-objects/money.js';
import { FailureCode } from '../enums/failure-code.js';
import { WagerTransactionKind } from '../enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.js';
import { InvalidTransactionStateError } from '../errors/invalid-transaction-state.error.js';
import { WagerTransaction } from './wager-transaction.js';

const createBet = (id = 'bet-1') =>
  WagerTransaction.create({
    id,
    providerId: 'provider-1',
    externalTransactionId: id,
    idempotencyKey: `key-${id}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
  });

describe('WagerTransaction', () => {
  it('starts pending, processes once, and treats terminal transitions as programming errors', () => {
    const transaction = createBet();
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    transaction.markProcessed(undefined, new Date());
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.reject(FailureCode.InsufficientBalance)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('requires a reference for refunds and uses the opposite direction for rollbacks', () => {
    const bet = createBet();
    bet.markProcessed(undefined, new Date());
    const rollback = WagerTransaction.create({
      id: 'rollback-1',
      providerId: 'provider-1',
      externalTransactionId: 'rollback-external-1',
      idempotencyKey: 'rollback-key-1',
      payloadHash: 'b'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-1',
    });
    rollback.assertValidReference(bet);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  it('marks missing references as pending and can later be processed', () => {
    const refund = WagerTransaction.create({
      providerId: 'provider-1',
      externalTransactionId: 'refund-1',
      idempotencyKey: 'refund-key-1',
      payloadHash: 'c'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-1',
    });
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    refund.markProcessed('internal-bet-id', new Date());
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
  });
});
