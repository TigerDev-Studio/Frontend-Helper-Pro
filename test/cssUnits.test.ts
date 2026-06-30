import assert from 'node:assert/strict';
import test from 'node:test';
import { convertCssUnit, findCssUnitAtOffset, formatNumber, getUnitConversions } from '../src/cssUnits.js';

const options = {
  baseFontSize: 16,
  viewportWidth: 375,
  rpxDesignWidth: 750,
  precision: 4
};

test('converts between px, rem, rpx, and vw', () => {
  assert.equal(convertCssUnit(16, 'px', 'rem', options), 1);
  assert.equal(convertCssUnit(1, 'rem', 'px', options), 16);
  assert.equal(convertCssUnit(10, 'px', 'rpx', options), 20);
  assert.equal(convertCssUnit(37.5, 'px', 'vw', options), 10);
});

test('formats generated values without trailing zeros', () => {
  assert.equal(formatNumber(1, 4), '1');
  assert.equal(formatNumber(1.25, 4), '1.25');
  assert.equal(formatNumber(1.23456, 3), '1.235');
});

test('finds css units at cursor offsets', () => {
  const text = '.card { margin: 16px 1rem; }';
  const match = findCssUnitAtOffset(text, text.indexOf('px'));

  assert.equal(match?.text, '16px');
  assert.equal(match?.value, 16);
  assert.equal(match?.unit, 'px');
});

test('returns conversions excluding the original unit', () => {
  const conversions = getUnitConversions({ value: 16, unit: 'px' }, options);

  assert.deepEqual(conversions.map((conversion) => conversion.replacement), ['1rem', '32rpx', '4.2667vw']);
});
