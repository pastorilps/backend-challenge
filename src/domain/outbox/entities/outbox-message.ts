import { randomUUID } from 'node:crypto';
import { IntegrationEvent } from '../../../shared/events/integration-event.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    const envelope = event.toJSON();
    const payload = OutboxMessage.freezeDeep(
      structuredClone({ ...envelope }) as Record<string, unknown>,
    );
    return new OutboxMessage(
      randomUUID(),
      event.aggregateId,
      event.eventType,
      payload,
      new Date(event.occurredAt),
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      OutboxMessage.freezeDeep(structuredClone({ ...state.payload })),
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined,
      state.publishedAt ? new Date(state.publishedAt) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt) : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    const currentTime = OutboxMessage.validDate(now, 'now');
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt <= currentTime)
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new RangeError(
        'A published outbox message cannot be published again.',
      );
    }
    const publishedAt = OutboxMessage.validDate(at, 'publishedAt');
    if (this._nextAttemptAt && publishedAt < this._nextAttemptAt) {
      throw new RangeError(
        'Outbox message cannot be published before its retry is due.',
      );
    }
    this._publishedAt = publishedAt;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new RangeError('A published outbox message cannot be retried.');
    }
    const scheduledAt = OutboxMessage.validDate(now, 'now');
    this._attempts += 1;
    const delayMs = Math.min(
      1_000 * 2 ** Math.min(this._attempts - 1, 8),
      300_000,
    );
    this._nextAttemptAt = new Date(scheduledAt.getTime() + delayMs);
  }

  private static validDate(value: Date, name: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new RangeError(`${name} must be a valid date.`);
    }
    return new Date(value);
  }

  private static freezeDeep<Value extends Record<string, unknown>>(
    value: Value,
  ): Readonly<Value> {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      if (
        nested !== null &&
        typeof nested === 'object' &&
        !Object.isFrozen(nested)
      ) {
        OutboxMessage.freezeDeep(nested as Record<string, unknown>);
      }
    }
    return value;
  }
}
