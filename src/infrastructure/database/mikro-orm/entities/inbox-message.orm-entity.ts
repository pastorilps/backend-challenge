export class InboxMessageOrmEntity {
  declare id: string;
  declare consumerName: string;
  declare messageId: string;
  declare payloadHash: string;
  declare payloadJson: Record<string, unknown>;
  declare receivedAt: Date;
  declare processedAt: Date | null;
  declare attempts: number;
  declare nextAttemptAt: Date | null;
  declare status: string;
}
