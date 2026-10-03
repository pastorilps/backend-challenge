import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateWagerTransactionDto } from './create-wager-transaction.dto.js';

function payload(kind: string, referenceExternalTransactionId?: string) {
  return plainToInstance(CreateWagerTransactionDto, {
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    playerId: '00000000-0000-4000-8000-000000000001',
    walletId: '00000000-0000-4000-8000-000000000002',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount: '25.00', currency: 'BRL' },
    ...(referenceExternalTransactionId
      ? { referenceExternalTransactionId }
      : {}),
  });
}

describe('CreateWagerTransactionDto validation', () => {
  it('accepts an ordinary BET payload', async () => {
    expect(await validate(payload('BET'))).toHaveLength(0);
  });

  it('requires a reference for REFUND and ROLLBACK', async () => {
    const errors = await validate(payload('REFUND'));
    expect(
      errors.some(
        (error) => error.property === 'referenceExternalTransactionId',
      ),
    ).toBe(true);
  });

  it('does not allow internal OPENING transactions through the public API', async () => {
    const errors = await validate(payload('OPENING'));
    expect(errors.some((error) => error.property === 'kind')).toBe(true);
  });

  it('rejects non-BRL or malformed money input', async () => {
    const input = payload('BET');
    input.money.amount = '1e3';
    input.money.currency = 'USD';
    const errors = await validate(input);
    expect(errors.some((error) => error.property === 'money')).toBe(true);
  });
});
