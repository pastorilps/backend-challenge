export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  InvalidTransaction = 'INVALID_TRANSACTION',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
}
