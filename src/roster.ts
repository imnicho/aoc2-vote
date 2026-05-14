/**
 * Parses the vanilla minecraft `/list` response:
 *   There are 3 of a max of 20 players online: alice, bob, charlie
 *
 * Returns the player array (possibly empty) or null if the line did not match.
 */
const LIST_REGEX = /There are (\d+) of a max of (\d+) players online:\s*(.*)$/;
const JOIN_REGEX = /^\s*(\w{3,16}) joined the game\s*$/;
const LEAVE_REGEX = /^\s*(\w{3,16}) left the game\s*$/;
const IGN_RE = /^[A-Za-z0-9_]{3,16}$/;

export interface ListResult {
  online: number;
  max: number;
  players: string[];
}

export function parseListLine(line: string): ListResult | null {
  const stripped = stripPrefixes(line);
  const m = LIST_REGEX.exec(stripped);
  if (!m) return null;
  const online = Number.parseInt(m[1] ?? '0', 10);
  const max = Number.parseInt(m[2] ?? '0', 10);
  const tail = (m[3] ?? '').trim();
  const players =
    tail.length === 0
      ? []
      : tail
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
  return { online, max, players };
}

export function parseJoinLine(line: string): string | null {
  const stripped = stripPrefixes(line);
  const m = JOIN_REGEX.exec(stripped);
  if (!m) return null;
  const ign = m[1] ?? '';
  if (!IGN_RE.test(ign)) return null;
  return ign;
}

export function parseLeaveLine(line: string): string | null {
  const stripped = stripPrefixes(line);
  const m = LEAVE_REGEX.exec(stripped);
  if (!m) return null;
  const ign = m[1] ?? '';
  if (!IGN_RE.test(ign)) return null;
  return ign;
}

function stripPrefixes(line: string): string {
  return line.replace(/^\s*\[[^\]]*\]:?\s*/, '').replace(/\[[0-9;]*m/g, '');
}

/**
 * In-memory roster cache. Refreshed by ptero.ts via list-command polling and
 * by direct join/leave console events.
 */
export class Roster {
  private players: string[] = [];
  private lastUpdated = 0;
  private listeners = new Set<() => void>();
  private joinListeners = new Set<(ign: string) => void>();
  private leaveListeners = new Set<(ign: string) => void>();
  // AFK tracking — all entries lowercase. Ephemeral, not persisted.
  private afk = new Set<string>();

  set(players: string[]): boolean {
    const next = [...players].sort((a, b) => a.localeCompare(b));
    const changed =
      next.length !== this.players.length ||
      next.some((p, i) => p !== this.players[i]);
    this.players = next;
    this.lastUpdated = Date.now();
    // Drop AFK entries for anyone who's no longer online.
    if (this.afk.size > 0) {
      const online = new Set(this.players.map((p) => p.toLowerCase()));
      for (const k of this.afk) {
        if (!online.has(k)) this.afk.delete(k);
      }
    }
    if (changed) this.emit();
    return changed;
  }

  /**
   * Add an IGN to the roster (no-op if already present). Returns true if the
   * roster changed. Fires onChange + onPlayerJoin when the IGN was new.
   */
  addPlayer(ign: string): boolean {
    if (!IGN_RE.test(ign)) return false;
    const lower = ign.toLowerCase();
    if (this.players.some((p) => p.toLowerCase() === lower)) return false;
    this.players = [...this.players, ign].sort((a, b) => a.localeCompare(b));
    this.lastUpdated = Date.now();
    this.emit();
    for (const fn of this.joinListeners) {
      try {
        fn(ign);
      } catch {
        // listener errors do not propagate
      }
    }
    return true;
  }

  /**
   * Remove an IGN from the roster (no-op if not present). Returns true if
   * the roster changed. Fires onChange + onPlayerLeave when the IGN was
   * actually present.
   */
  removePlayer(ign: string): boolean {
    if (!IGN_RE.test(ign)) return false;
    const lower = ign.toLowerCase();
    const next = this.players.filter((p) => p.toLowerCase() !== lower);
    if (next.length === this.players.length) return false;
    this.players = next;
    this.lastUpdated = Date.now();
    this.afk.delete(lower);
    this.emit();
    for (const fn of this.leaveListeners) {
      try {
        fn(ign);
      } catch {
        // listener errors do not propagate
      }
    }
    return true;
  }

  get(): string[] {
    return [...this.players];
  }

  has(ign: string): boolean {
    const needle = ign.toLowerCase();
    return this.players.some((p) => p.toLowerCase() === needle);
  }

  size(): number {
    return this.players.length;
  }

  /**
   * Mark `ign` as AFK. Only flags players already in the roster; returns true
   * when the state actually changed. Fires onChange on transition.
   */
  markAfk(ign: string): boolean {
    if (!IGN_RE.test(ign)) return false;
    const lower = ign.toLowerCase();
    if (!this.players.some((p) => p.toLowerCase() === lower)) return false;
    if (this.afk.has(lower)) return false;
    this.afk.add(lower);
    this.emit();
    return true;
  }

  /**
   * Clear the AFK flag for `ign`. Returns true if the state changed (i.e.,
   * the player was AFK and is now active). Fires onChange on transition.
   */
  markActive(ign: string): boolean {
    if (!IGN_RE.test(ign)) return false;
    const lower = ign.toLowerCase();
    if (!this.afk.has(lower)) return false;
    this.afk.delete(lower);
    this.emit();
    return true;
  }

  isAfk(ign: string): boolean {
    return this.afk.has(ign.toLowerCase());
  }

  afkList(): string[] {
    return [...this.afk];
  }

  /** Online players minus AFK players — used as the vote denominator. */
  activeCount(): number {
    return Math.max(0, this.players.length - this.afk.size);
  }

  age(): number {
    return Date.now() - this.lastUpdated;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onPlayerJoin(fn: (ign: string) => void): () => void {
    this.joinListeners.add(fn);
    return () => this.joinListeners.delete(fn);
  }

  onPlayerLeave(fn: (ign: string) => void): () => void {
    this.leaveListeners.add(fn);
    return () => this.leaveListeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // listener errors do not propagate
      }
    }
  }
}
