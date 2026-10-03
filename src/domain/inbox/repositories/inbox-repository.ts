import { InboxMessage } from '../entities/inbox-message.js';

export abstract class InboxRepository {
  abstract findByConsumerAndMessageId(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null>;
  abstract save(message: InboxMessage): Promise<void>;
}
