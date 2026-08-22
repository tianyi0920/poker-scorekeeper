import { expect, it } from 'vitest';
import { finalMoneyPresentation, formatSignedMoney, formatUnsignedMoney } from './money-format.js';

it.each([
  ['1700', '+¥1,700'], ['-1700', '−¥1,700'], ['0', '¥0']
] as const)('formats %s as %s', (value, expected) => {
  // Break caught: a display drops a sign, uses ASCII minus, or converts a large integer through Number.
  expect(formatSignedMoney(value)).toBe(expected);
});

it('renders an unsigned final payable amount with negative tone', () => {
  // Break caught: a payable result renders as a contradictory negative amount.
  expect(finalMoneyPresentation('-1700')).toEqual({
    label: '最终应付', amount: '¥1,700', tone: 'negative'
  });
});

it('formats unsigned amounts by absolute value', () => {
  // Break caught: fee and final displays expose a leading negative sign.
  expect(formatUnsignedMoney('-1700')).toBe('¥1,700');
});
