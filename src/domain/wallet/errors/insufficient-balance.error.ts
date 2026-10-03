import { AppError } from '../../../shared/errors/app.error.js';

export class InsufficientBalanceError extends AppError {
  constructor() {
    super('Wallet has insufficient balance.', 'INSUFFICIENT_BALANCE', 422);
  }
}
