import { AppError } from './app.error.js';

export class InvalidMoneyError extends AppError {
  constructor(message: string) {
    super(message, 'INVALID_MONEY', 400);
  }
}
