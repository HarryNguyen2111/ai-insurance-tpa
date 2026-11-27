import { Decimal } from 'decimal.js';

/** Isolated Decimal constructor: never mutates the global decimal.js config. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Money = InstanceType<typeof D>;

export class WaterfallInputError extends Error {
  constructor(field: string) { super(`Invalid waterfall input: ${field}`); this.name = 'WaterfallInputError'; }
}

const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const PERCENT = /^(100\.00|[0-9]{1,2}\.[0-9]{2})$/;

/** NUMERIC(15,2) string -> Decimal. JS numbers are rejected (Zero Float rule). */
export function parseMoney(value: unknown, field: string): Money {
  if (typeof value !== 'string' || !MONEY.test(value)) throw new WaterfallInputError(field);
  return new D(value);
}
/** NUMERIC(5,2) percentage string in [0, 100]. */
export function parsePercent(value: unknown, field: string): Money {
  if (typeof value !== 'string' || !PERCENT.test(value)) throw new WaterfallInputError(field);
  return new D(value);
}
/** ROUND_HALF_UP to whole VND (spec 03 step 3). */
export const roundVnd = (value: Money): Money => value.toDecimalPlaces(0, D.ROUND_HALF_UP);
/** JSON/DB string with exactly two decimals, e.g. "720000.00". */
export const formatMoney = (value: Money): string => value.toFixed(2, D.ROUND_HALF_UP);
export const minMoney = (...values: Money[]): Money => D.min(...values);
export const ZERO = new D(0);
