import { AppError } from '../../../shared/errors/app.error.js';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.js';

export class InvalidTransactionStateError extends AppError {
  constructor(status: WagerTransactionStatus, action: string) {
    super(
      `Cannot ${action} a transaction in state ${status}.`,
      'INVALID_TRANSACTION_STATE',
      409,
    );
  }
}
