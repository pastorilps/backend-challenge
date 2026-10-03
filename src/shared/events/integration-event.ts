import { randomUUID } from 'node:crypto';

export interface IntegrationEventProps<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
  data: T;
}

export interface EventContext {
  correlationId: string;
  causationId?: string;
  eventId?: string;
  occurredAt?: Date;
}

export interface SerializedIntegrationEvent<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    IntegrationEvent.assertIdentifier(props.aggregateId, 'aggregateId');
    IntegrationEvent.assertIdentifier(props.correlationId, 'correlationId');
    this.eventId = props.eventId ?? randomUUID();
    IntegrationEvent.assertIdentifier(this.eventId, 'eventId');
    if (props.causationId !== undefined) {
      IntegrationEvent.assertIdentifier(props.causationId, 'causationId');
    }
    const occurredAt = props.occurredAt ?? new Date();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new RangeError('Event occurrence date must be valid.');
    }
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(occurredAt);
    this.data = IntegrationEvent.freezeDeep(structuredClone(props.data));
  }

  toJSON(): SerializedIntegrationEvent<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data) as T,
    };
  }

  private static assertIdentifier(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new RangeError(`${name} must be a non-empty string.`);
    }
  }

  private static freezeDeep<Value>(value: Value): Readonly<Value> {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Object.isFrozen(value)
    ) {
      Object.freeze(value);
      for (const nested of Object.values(value)) {
        IntegrationEvent.freezeDeep(nested);
      }
    }
    return value;
  }
}
