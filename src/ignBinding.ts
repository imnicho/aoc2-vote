/**
 * Soft-binds an IGN to a source IP with a sliding TTL.
 *
 * - First-touch for an unknown IGN records the IP and returns ok.
 * - A subsequent call with the same IGN from the same IP refreshes the expiry.
 * - A call from a different IP while a binding is live is rejected with
 *   `kind: 'mismatch'`. Once the binding expires it is evicted on next access
 *   and the new IP becomes the binding.
 *
 * The store is in-memory and process-local. Across restarts bindings are
 * forgotten, which is fine — the worst case is one missed griefing window
 * after a deploy.
 */
export interface BindingHit {
  kind: 'ok';
}

export interface BindingMiss {
  kind: 'mismatch';
}

export type BindingResult = BindingHit | BindingMiss;

interface Entry {
  ip: string;
  expires_at: number;
}

export class IgnBinding {
  private readonly map = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 10 * 60 * 1000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /**
   * Check whether `ign` may act from `ip`. Does NOT mutate state — call
   * `record()` after a successful mutating operation to refresh the binding.
   */
  check(ign: string, ip: string): BindingResult {
    const key = ign.toLowerCase();
    const entry = this.map.get(key);
    const t = this.now();
    if (!entry) return { kind: 'ok' };
    if (entry.expires_at <= t) {
      this.map.delete(key);
      return { kind: 'ok' };
    }
    if (entry.ip !== ip) return { kind: 'mismatch' };
    return { kind: 'ok' };
  }

  /**
   * Upsert a binding for `ign -> ip` with a fresh TTL window.
   */
  record(ign: string, ip: string): void {
    const key = ign.toLowerCase();
    this.map.set(key, { ip, expires_at: this.now() + this.ttlMs });
  }

  /**
   * For tests: how many active bindings exist (does not sweep expired).
   */
  size(): number {
    return this.map.size;
  }

  /**
   * Drop all bindings whose TTL has elapsed.
   */
  sweep(): void {
    const t = this.now();
    for (const [k, v] of this.map) {
      if (v.expires_at <= t) this.map.delete(k);
    }
  }
}
