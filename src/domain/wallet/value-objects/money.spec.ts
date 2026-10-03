import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError } from '../../../shared/errors/currency-mismatch.error.js';
import { InvalidMoneyError } from '../../../shared/errors/invalid-money.error.js';
import { Money } from './money.js';

describe('Money', () => {
  it('uses exact integer arithmetic and serializes with two decimal places', () => {
    const left = Money.from({ amount: '25.1', currency: 'BRL' });
    const right = Money.from({ amount: '0.90', currency: 'BRL' });

    expect(left.add(right).toJSON()).toEqual({
      amount: '26.00',
      currency: 'BRL',
    });
    expect(left.subtract(right).toString()).toBe('24.20');
    expect(
      Money.from({ amount: '0.01', currency: 'BRL' }).negate().toString(),
    ).toBe('-0.01');
  });

  it.each(['-1.00', '1.001', '1e2', 'NaN', 'Infinity', ''])(
    'rejects invalid amount %s',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  it('rejects arithmetic between currencies', () => {
    expect(() =>
      Money.from({ amount: '1.00', currency: 'BRL' }).add(
        Money.from({ amount: '1.00', currency: 'USD' }),
      ),
    ).toThrow(CurrencyMismatchError);
  });
});
