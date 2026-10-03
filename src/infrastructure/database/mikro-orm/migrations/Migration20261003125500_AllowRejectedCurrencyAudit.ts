import { Migration } from '@mikro-orm/migrations';

export class Migration20261003125500_AllowRejectedCurrencyAudit extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'alter table "wager_transactions" drop constraint "wager_transactions_money_currency_check";',
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      'alter table "wager_transactions" add constraint "wager_transactions_money_currency_check" check ("money_currency" = \'BRL\');',
    );
  }
}
