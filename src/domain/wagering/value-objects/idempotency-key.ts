import { AppError } from '../../../shared/errors/app.error.js';

export class IdempotencyKey {
  private constructor(public readonly value: string) {}

  static from(value: string): IdempotencyKey {
    if (
      typeof value !== 'string' ||
      value.trim() !== value ||
      value.length === 0 ||
      value.length > 255
    ) {
      throw new AppError(
        'Idempotency key must contain between 1 and 255 non-whitespace characters.',
        'INVALID_IDEMPOTENCY_KEY',
        400,
      );
    }
    return new IdempotencyKey(value);
  }

  equals(other: IdempotencyKey): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
