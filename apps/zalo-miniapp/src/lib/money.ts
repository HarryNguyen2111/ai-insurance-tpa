import Decimal from 'decimal.js';

/**
 * VND money is always a JSON string shaped like OpenAPI `Money` (NUMERIC(15,2)).
 * Never parse it into a JS `number`; all arithmetic goes through decimal.js ROUND_HALF_UP.
 */
export type Money = string;

export const MONEY_PATTERN = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function isMoney(value: unknown): value is Money {
  return typeof value === 'string' && MONEY_PATTERN.test(value);
}

function assertMoney(value: unknown): asserts value is Money {
  if (!isMoney(value)) throw new TypeError(`Not an OpenAPI Money string: ${String(value)}`);
}

/** Sum Money strings exactly; result is a Money string with two decimals. */
export function sumMoney(values: readonly Money[]): Money {
  let total = new D(0);
  for (const v of values) {
    assertMoney(v);
    total = total.plus(v);
  }
  return total.toFixed(2, D.ROUND_HALF_UP);
}

export function moneyEquals(a: Money, b: Money): boolean {
  assertMoney(a);
  assertMoney(b);
  return new D(a).equals(b);
}

/**
 * Display "1234567.50" as "1.234.568 ₫" (rounded to whole đồng, ROUND_HALF_UP, vi-VN grouping).
 * Grouping is done on the decimal string, so no float conversion ever happens.
 */
export function formatVnd(value: Money): string {
  assertMoney(value);
  const whole = new D(value).toFixed(0, D.ROUND_HALF_UP);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped} ₫`;
}
