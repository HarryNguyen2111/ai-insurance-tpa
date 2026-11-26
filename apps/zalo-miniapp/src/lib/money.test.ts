import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVnd, isMoney, moneyEquals, sumMoney } from './money.ts';

test('isMoney follows the OpenAPI Money pattern', () => {
  for (const ok of ['0.00', '720000.00', '9999999999999.99']) assert.equal(isMoney(ok), true, ok);
  for (const bad of ['720000', '720000.0', '01.00', '-1.00', '1e6', 720000, null, '10000000000000.00']) {
    assert.equal(isMoney(bad), false, String(bad));
  }
});

test('formatVnd groups vi-VN style and rounds HALF_UP to whole đồng', () => {
  assert.equal(formatVnd('720000.00'), '720.000 ₫');
  assert.equal(formatVnd('1234567.50'), '1.234.568 ₫');
  assert.equal(formatVnd('1234567.49'), '1.234.567 ₫');
  assert.equal(formatVnd('0.00'), '0 ₫');
  assert.equal(formatVnd('9999999999999.99'), '10.000.000.000.000 ₫');
});

test('sumMoney is exact (no IEEE-754 drift) and returns a Money string', () => {
  assert.equal(sumMoney(['0.10', '0.20']), '0.30');
  assert.equal(sumMoney(['300000.00', '420000.00', '0.00']), '720000.00');
  assert.equal(sumMoney([]), '0.00');
  assert.ok(moneyEquals(sumMoney(['9999999999999.98', '0.01']), '9999999999999.99'));
});

test('money helpers refuse JS numbers and malformed strings', () => {
  assert.throws(() => formatVnd(720000 as unknown as string), TypeError);
  assert.throws(() => sumMoney(['1.5']), TypeError);
});
