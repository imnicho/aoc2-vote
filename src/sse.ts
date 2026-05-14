export type Subscriber = (payload: string) => void;

export interface StateSnapshot {
  online: string[];
  afk: string[];
  polls: PublicPoll[];
  cooldowns: Record<string, number>;
  last_tps: string | null;
  server_status: 'running' | 'starting' | 'offline' | 'unknown';
  operator_enabled: boolean;
  uptime_ms: number | null;
  ping_ms: number | null;
}

export interface PublicPoll {
  id: string;
  short_id: string;
  action: string;
  initiator: string;
  voters: string[];
  abstained: number;
  needed: number;
  expires_at: number;
  status: string;
}

export class SseBroadcaster {
  private subs = new Set<Subscriber>();
  private current: StateSnapshot | null = null;
  private inFlight = 0; // connecting + subscribed, decremented on finally/abort
  private perIp = new Map<string, number>();
  readonly maxClients: number;
  readonly maxPerIp: number;

  constructor(maxClients = 200, maxPerIp = 4) {
    this.maxClients = maxClients;
    this.maxPerIp = maxPerIp;
  }

  size(): number {
    return this.subs.size;
  }

  /**
   * Total connections currently passing through `/api/state` — counts both
   * sockets that have passed the gate and not yet attached a subscriber, and
   * those already subscribed. Used to enforce the global cap atomically.
   */
  inFlightCount(): number {
    return this.inFlight;
  }

  perIpCount(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  /**
   * Atomically reserve a slot at the gate. Returns a release callback that
   * must be invoked exactly once on stream end. The cap covers both
   * connecting and subscribed sockets.
   */
  reserve(ip: string): { ok: true; release: () => void } | { ok: false; reason: 'global' | 'per_ip' } {
    if (this.inFlight >= this.maxClients) return { ok: false, reason: 'global' };
    const current = this.perIp.get(ip) ?? 0;
    if (current >= this.maxPerIp) return { ok: false, reason: 'per_ip' };
    this.inFlight += 1;
    this.perIp.set(ip, current + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
        const n = (this.perIp.get(ip) ?? 0) - 1;
        if (n <= 0) this.perIp.delete(ip);
        else this.perIp.set(ip, n);
      },
    };
  }

  current_snapshot(): StateSnapshot | null {
    return this.current;
  }

  publish(snapshot: StateSnapshot): void {
    this.current = snapshot;
    const payload = JSON.stringify(snapshot);
    for (const fn of this.subs) {
      try {
        fn(payload);
      } catch {
        // ignore; failed subs will be removed when their stream closes
      }
    }
  }

  subscribe(fn: Subscriber): { ok: true; unsubscribe: () => void } | { ok: false } {
    if (this.subs.size >= this.maxClients) return { ok: false };
    const wasZero = this.subs.size === 0;
    this.subs.add(fn);
    if (wasZero) this.notifyActivity(true);
    return {
      ok: true,
      unsubscribe: () => {
        const had = this.subs.delete(fn);
        if (had && this.subs.size === 0) this.notifyActivity(false);
      },
    };
  }

  /**
   * Notify listeners when the dashboard goes from idle → watched or
   * watched → idle. Backend can use this to pause expensive polling when
   * nobody has the page open.
   */
  private activityListeners = new Set<(active: boolean) => void>();
  onActivityChange(fn: (active: boolean) => void): () => void {
    this.activityListeners.add(fn);
    return () => this.activityListeners.delete(fn);
  }
  private notifyActivity(active: boolean): void {
    for (const fn of this.activityListeners) {
      try { fn(active); } catch { /* ignore */ }
    }
  }
}
