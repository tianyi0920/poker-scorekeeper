import { fromDbMoney, toDbMoney } from '../src/prisma/prisma-money.js';

describe('Prisma money boundary', () => {
  it('preserves exact bigint values in both directions', () => {
    const amount = 9_007_199_254_740_993n;

    expect(toDbMoney(amount)).toBe(amount);
    expect(fromDbMoney(amount)).toBe(amount);
  });
});
