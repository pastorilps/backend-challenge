import { WagerTransaction } from '../entities/wager-transaction.js';

export abstract class WagerTransactionRepository {
  abstract findById(id: string): Promise<WagerTransaction | null>;
  abstract findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  abstract findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  abstract findPendingReferences(limit: number): Promise<WagerTransaction[]>;
  abstract save(transaction: WagerTransaction): Promise<void>;
}
