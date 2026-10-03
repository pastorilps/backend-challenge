import { EntityManager } from '@mikro-orm/core';

export async function acquireTransactionAdvisoryLock(
  entityManager: EntityManager,
  scope: string,
  ...identifiers: string[]
): Promise<void> {
  const lockKey = JSON.stringify([scope, ...identifiers]);
  await entityManager
    .getConnection()
    .execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [lockKey]);
}
