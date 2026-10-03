import { AppError } from '../../../shared/errors/app.error.js';

export class InboxMessageAlreadyProcessedError extends AppError {
  constructor() {
    super(
      'The inbox message has already reached a terminal state.',
      'INBOX_MESSAGE_ALREADY_PROCESSED',
      409,
    );
  }
}
