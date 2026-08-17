import { LoginAttemptLimiter } from '../src/auth/login-attempt-limiter.js';

describe('LoginAttemptLimiter', () => {
  it('evicts the least-recently-used key when the hard capacity is reached', () => {
    const limiter = new LoginAttemptLimiter({
      limit: 1,
      ttlMilliseconds: 60_000,
      capacity: 2
    });
    limiter.recordFailure('first');
    limiter.recordFailure('second');
    expect(limiter.isAllowed('first')).toBe(false);

    limiter.recordFailure('third');

    expect(limiter.isAllowed('first')).toBe(false);
    expect(limiter.isAllowed('second')).toBe(true);
    expect(limiter.isAllowed('third')).toBe(false);
  });

  it('globally removes expired entries before they can evict an active key', () => {
    let now = 0;
    const limiter = new LoginAttemptLimiter({
      limit: 1,
      ttlMilliseconds: 100,
      capacity: 3,
      now: () => now
    });
    limiter.recordFailure('expired-first');
    limiter.recordFailure('expired-second');
    now = 50;
    limiter.recordFailure('active-survivor');
    now = 90;
    expect(limiter.isAllowed('expired-second')).toBe(false);

    now = 100;
    limiter.recordFailure('newcomer-first');
    limiter.recordFailure('newcomer-second');

    expect(limiter.isAllowed('active-survivor')).toBe(false);
    expect(limiter.isAllowed('expired-first')).toBe(true);
    expect(limiter.isAllowed('expired-second')).toBe(true);
  });

  it('allows a key immediately after a successful-login reset', () => {
    const limiter = new LoginAttemptLimiter({
      limit: 1,
      ttlMilliseconds: 60_000,
      capacity: 2
    });
    limiter.recordFailure('account');
    expect(limiter.isAllowed('account')).toBe(false);

    limiter.reset('account');

    expect(limiter.isAllowed('account')).toBe(true);
  });
});
