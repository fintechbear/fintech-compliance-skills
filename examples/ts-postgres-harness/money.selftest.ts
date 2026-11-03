// Pure (no-DB) self-test for money.ts — FCS-MONEY-001 parser contract.
// Run: node --import tsx --test money.selftest.ts
//
// Regression guard for the prototype-pollution hole: before the fix, MINOR_UNITS was a
// plain object literal, so MINOR_UNITS['constructor'] / ['toString'] / ['__proto__']
// resolved through Object.prototype and those names parsed as a supported currency
// returning minor units of 1. The table is now null-prototype with an own-property
// lookup, so inherited members are rejected as unsupported_currency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinorUnits, isSupported, MoneyError } from './money.ts';

function kind(fn: () => unknown): string {
  try { fn(); return 'NO_THROW'; }
  catch (e) { return e instanceof MoneyError ? e.kind : `OTHER:${(e as Error).message}`; }
}

test('inherited Object members are not supported currencies', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable']) {
    assert.equal(isSupported(name), false, `${name} must not be supported`);
    assert.equal(kind(() => toMinorUnits('1', name)), 'unsupported_currency', `${name} must reject`);
  }
});

test('non-string currency is rejected, not coerced', () => {
  // @ts-expect-error deliberately wrong type to prove the guard
  assert.equal(isSupported(undefined), false);
  // @ts-expect-error
  assert.equal(kind(() => toMinorUnits('1', 123)), 'unsupported_currency');
});

test('supported currencies parse to exact minor units', () => {
  assert.equal(toMinorUnits('1', 'USD'), 100);
  assert.equal(toMinorUnits('0.29', 'USD'), 29);
  assert.equal(toMinorUnits('1.00', 'USD'), 100);
  assert.equal(toMinorUnits('5', 'JPY'), 5);          // 0-decimal
  assert.equal(toMinorUnits('1.234', 'KWD'), 1234);   // 3-decimal
  assert.equal(toMinorUnits('10.500', 'BHD'), 10500);
  assert.ok(isSupported('USD') && isSupported('JPY') && isSupported('KWD'));
  assert.equal(isSupported('XTS'), false);
});

test('precision / sign / range contract preserved', () => {
  assert.equal(kind(() => toMinorUnits('1.005', 'USD')), 'over_precision');
  assert.equal(kind(() => toMinorUnits('1.5', 'JPY')), 'over_precision');
  assert.equal(kind(() => toMinorUnits('0', 'USD')), 'non_positive');
  assert.equal(kind(() => toMinorUnits('-1', 'USD')), 'non_positive');
  assert.equal(kind(() => toMinorUnits('99999999999999999', 'USD')), 'overflow');
  assert.equal(kind(() => toMinorUnits('abc', 'USD')), 'bad_amount');
  assert.equal(kind(() => toMinorUnits('1.00', 'XTS')), 'unsupported_currency');
});
