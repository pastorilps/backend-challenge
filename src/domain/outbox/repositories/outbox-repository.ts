import { OutboxMessage } from '../entities/outbox-message.js';

export abstract class OutboxRepository {
  abstract findDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  abstract save(message: OutboxMessage): Promise<void>;
}
