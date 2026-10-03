import { EntityManager } from '@mikro-orm/core';
import { PendingReferenceReprocessor } from './wager-transaction-processor.js';

export class ReprocessPendingReferencesUseCase {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly reprocessor: PendingReferenceReprocessor,
  ) {}

  execute(now = new Date(), limit = 50): Promise<number> {
    return this.reprocessor.reprocessPendingReferences(
      this.entityManager,
      now,
      limit,
    );
  }
}
