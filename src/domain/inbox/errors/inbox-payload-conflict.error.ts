import { AppError } from '../../../shared/errors/app.error.js';

export class InboxPayloadConflictError extends AppError {
  constructor() {
    super(
      'An inbox message ID was received with a different payload.',
      'INBOX_PAYLOAD_CONFLICT',
      409,
    );
  }
}
