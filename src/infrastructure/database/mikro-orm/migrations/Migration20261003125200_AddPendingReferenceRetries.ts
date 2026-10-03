import { Migration } from '@mikro-orm/migrations';

export class Migration20261003125200_AddPendingReferenceRetries extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'alter table "wager_transactions" add column "reference_attempts" integer not null default 0;',
    );
    this.addSql(
      'alter table "wager_transactions" add column "reference_next_attempt_at" timestamptz null;',
    );
    this.addSql(
      'alter table "wager_transactions" add constraint "wager_transactions_reference_attempts_check" check ("reference_attempts" >= 0);',
    );
    this.addSql(
      'create index "wager_transactions_pending_reference_idx" on "wager_transactions" ("reference_next_attempt_at") where "status" = \'PENDING_REFERENCE\';',
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop index "wager_transactions_pending_reference_idx";');
    this.addSql(
      'alter table "wager_transactions" drop constraint "wager_transactions_reference_attempts_check";',
    );
    this.addSql(
      'alter table "wager_transactions" drop column "reference_next_attempt_at";',
    );
    this.addSql(
      'alter table "wager_transactions" drop column "reference_attempts";',
    );
  }
}
