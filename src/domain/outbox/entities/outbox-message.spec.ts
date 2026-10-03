import { describe, expect, it } from 'vitest';
import { IntegrationEvent } from '../../../shared/events/integration-event.js';
import { OutboxMessage } from './outbox-message.js';

class TestEvent extends IntegrationEvent<{ value: number }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;

  constructor() {
    super({
      eventId: 'event-1',
      aggregateId: 'aggregate-1',
      correlationId: 'correlation-1',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      data: { value: 1 },
    });
  }
}

describe('OutboxMessage', () => {
  it('uses exponential backoff and becomes publishable when due', () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const message = OutboxMessage.enqueue(new TestEvent());

    expect(message.isDue(occurredAt)).toBe(true);
    message.scheduleRetry(occurredAt);
    expect(message.attempts).toBe(1);
    expect(message.isDue(new Date(occurredAt.getTime() + 999))).toBe(false);
    expect(message.isDue(new Date(occurredAt.getTime() + 1_000))).toBe(true);
    message.markPublished(new Date(occurredAt.getTime() + 1_000));
    expect(message.isPending()).toBe(false);
  });
});
