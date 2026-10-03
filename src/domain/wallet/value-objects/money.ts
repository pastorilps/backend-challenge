import { CurrencyMismatchError } from '../../../shared/errors/currency-mismatch.error.js';
import { InvalidMoneyError } from '../../../shared/errors/invalid-money.error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const MINOR_UNITS_PER_MAJOR_UNIT = 100n;
const MAX_ABSOLUTE_MINOR_UNITS = 10n ** 19n - 1n;

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string') {
      throw new InvalidMoneyError('Money amount must be a decimal string.');
    }

    const currency = Money.validateCurrency(props.currency);
    const match = /^(0|[1-9]\d{0,16})(?:\.(\d{1,2}))?$/.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        'Money amount must be a non-negative decimal with at most two fractional digits.',
      );
    }

    const whole = BigInt(match[1]);
    const fractional = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
    return new Money(whole * MINOR_UNITS_PER_MAJOR_UNIT + fractional, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.validateCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(
      this.minorUnits + other.minorUnits,
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(
      this.minorUnits - other.minorUnits,
      this.currency,
    );
  }

  negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const whole = absolute / MINOR_UNITS_PER_MAJOR_UNIT;
    const fraction = (absolute % MINOR_UNITS_PER_MAJOR_UNIT)
      .toString()
      .padStart(2, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  private static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    if (
      minorUnits > MAX_ABSOLUTE_MINOR_UNITS ||
      minorUnits < -MAX_ABSOLUTE_MINOR_UNITS
    ) {
      throw new InvalidMoneyError(
        'Money amount exceeds the supported precision.',
      );
    }
    return new Money(minorUnits, currency);
  }

  private static validateCurrency(currency: string): string {
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError(
        'Currency must be a three-letter uppercase ISO code.',
      );
    }
    return currency;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
