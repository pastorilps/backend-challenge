import { Migration } from '@mikro-orm/migrations';

export class Migration20261003124500_AddIdempotencyResponse extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'alter table "wager_transactions" add column "idempotency_response" jsonb null;',
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      'alter table "wager_transactions" drop column "idempotency_response";',
    );
  }
}
