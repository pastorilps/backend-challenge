import { AppError } from './app.error.js';

export class CurrencyMismatchError extends AppError {
  constructor(expected: string, actual: string) {
    super(
      `Currency mismatch: expected ${expected}, received ${actual}.`,
      'CURRENCY_MISMATCH',
      422,
    );
  }
}
