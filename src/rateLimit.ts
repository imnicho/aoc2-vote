/**
 * Simple per-IP token bucket. 10 tokens / minute, refill linearly.
 */
export interface RateLimitOptions {
  capacity: number;
  refillPerMs: number; // tokens per ms
}

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private opts: RateLimitOptions;

  constructor(opts: RateLimitOptions = { capacity: 10, refillPerMs: 10 / 60_000 }) {
    this.opts = opts;
  }

  take(key: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.opts.capacity, updated: now };
      this.buckets.set(key, b);
    }
    const elapsed = now - b.updated;
    b.tokens = Math.min(this.opts.capacity, b.tokens + elapsed * this.opts.refillPerMs);
    b.updated = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /**
   * Periodically called to drop fully-replenished buckets and keep the map bounded.
   */
  sweep(): void {
    const now = Date.now();
    for (const [key, b] of this.buckets) {
      const elapsed = now - b.updated;
      const replenished = Math.min(this.opts.capacity, b.tokens + elapsed * this.opts.refillPerMs);
      if (replenished >= this.opts.capacity && now - b.updated > 60_000) {
        this.buckets.delete(key);
      }
    }
  }
}
