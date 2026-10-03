import { describe, expect, it } from 'vitest';
import { InboxMessage } from './inbox-message.js';

describe('InboxMessage', () => {
  it('records processing once and is idempotent on duplicate acknowledgements', () => {
    const receivedAt = new Date('2026-01-01T00:00:00.000Z');
    const message = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-consumer',
      payloadHash: 'a'.repeat(64),
      receivedAt,
    });

    message.markProcessed(new Date(receivedAt.getTime() + 1_000));
    const processedAt = message.processedAt;
    message.markProcessed(new Date(receivedAt.getTime() + 2_000));

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
  });
});
