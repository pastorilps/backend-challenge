import { AppError } from '../../../shared/errors/app.error.js';

export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      'The idempotency key was already used with a different payload.',
      'IDEMPOTENCY_CONFLICT',
      409,
    );
  }
}
