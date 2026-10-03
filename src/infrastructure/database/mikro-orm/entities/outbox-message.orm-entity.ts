export class OutboxMessageOrmEntity {
  declare id: string;
  declare aggregateId: string;
  declare eventType: string;
  declare payloadJson: Record<string, unknown>;
  declare occurredAt: Date;
  declare attempts: number;
  declare nextAttemptAt: Date | null;
  declare publishedAt: Date | null;
  declare status: string;
}
