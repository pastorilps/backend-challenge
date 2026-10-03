import { LedgerDirection } from '../../domain/ledger/enums/ledger-direction.js';
import { WalletLedgerEntry } from '../../domain/ledger/entities/wallet-ledger-entry.js';
import { WagerTransaction } from '../../domain/wagering/entities/wager-transaction.js';
import { WagerTransactionKind } from '../../domain/wagering/enums/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/wagering/enums/wager-transaction-status.js';
import { Wallet } from '../../domain/wallet/entities/wallet.js';
import {
  EventContext,
  IntegrationEvent,
  IntegrationEventProps,
} from './integration-event.js';

interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: { amount: string; currency: string };
  failureCode?: string;
  referenceExternalTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed) {
      throw new RangeError('Only processed transactions can emit this event.');
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionData(transaction),
        status: transaction.status,
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionRejected {
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      !transaction.failureCode
    ) {
      throw new RangeError(
        'Rejected transaction event requires a rejected transaction and failure code.',
      );
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionData(transaction),
        status: transaction.status,
        failureCode: transaction.failureCode,
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    if (transaction.status !== WagerTransactionStatus.PendingReference) {
      throw new RangeError(
        'Pending-reference event requires a pending-reference transaction.',
      );
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionData(transaction),
        status: transaction.status,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId,
      },
    });
  }
}

interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (
      wallet.id !== entry.walletId ||
      !entry.isBalanced() ||
      !wallet.balance.equals(entry.balanceAfter)
    ) {
      throw new RangeError(
        'Wallet balance event requires a balanced entry for the wallet.',
      );
    }
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

function transactionData(
  transaction: WagerTransaction,
): Omit<WagerTransactionEventData, 'status'> {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}
