export interface LoginAttemptLimiterOptions {
  limit: number;
  ttlMilliseconds: number;
  capacity: number;
  now?: () => number;
}

interface LoginFailureState {
  count: number;
  resetAt: number;
}

export class LoginAttemptLimiter {
  private readonly entries = new Map<string, LoginFailureState>();
  private readonly now: () => number;

  constructor(private readonly options: LoginAttemptLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  isAllowed(key: string): boolean {
    const now = this.now();
    this.pruneExpired(now);
    const state = this.entries.get(key);
    if (state === undefined) return true;
    if (state.resetAt <= now) {
      this.entries.delete(key);
      return true;
    }
    this.touch(key, state);
    return state.count < this.options.limit;
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.pruneExpired(now);
    const state = this.entries.get(key);
    if (state === undefined) {
      this.ensureCapacity();
      this.entries.set(key, {
        count: 1,
        resetAt: now + this.options.ttlMilliseconds
      });
      return;
    }
    if (state.resetAt <= now) {
      this.entries.delete(key);
      this.ensureCapacity();
      this.entries.set(key, {
        count: 1,
        resetAt: now + this.options.ttlMilliseconds
      });
      return;
    }
    state.count += 1;
    this.touch(key, state);
  }

  reset(key: string): void {
    this.pruneExpired(this.now());
    this.entries.delete(key);
  }

  private pruneExpired(now: number): void {
    for (const [key, state] of this.entries) {
      if (state.resetAt <= now) this.entries.delete(key);
    }
  }

  private ensureCapacity(): void {
    if (this.entries.size < this.options.capacity) return;
    const leastRecentlyUsed = this.entries.keys().next().value as string | undefined;
    if (leastRecentlyUsed !== undefined) this.entries.delete(leastRecentlyUsed);
  }

  private touch(key: string, state: LoginFailureState): void {
    this.entries.delete(key);
    this.entries.set(key, state);
  }
}
