/**
 * Parses the vanilla minecraft `/list` response:
 *   There are 3 of a max of 20 players online: alice, bob, charlie
 *
 * Returns the player array (possibly empty) or null if the line did not match.
 */
const LIST_REGEX = /There are (\d+) of a max of (\d+) players online:\s*(.*)$/;

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

function stripPrefixes(line: string): string {
  return line.replace(/^\s*\[[^\]]*\]:?\s*/, '').replace(/\[[0-9;]*m/g, '');
}

/**
 * In-memory roster cache. Refreshed by ptero.ts via list-command polling.
 */
export class Roster {
  private players: string[] = [];
  private lastUpdated = 0;
  private listeners = new Set<() => void>();

  set(players: string[]): boolean {
    const next = [...players].sort((a, b) => a.localeCompare(b));
    const changed =
      next.length !== this.players.length ||
      next.some((p, i) => p !== this.players[i]);
    this.players = next;
    this.lastUpdated = Date.now();
    if (changed) this.emit();
    return changed;
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

  age(): number {
    return Date.now() - this.lastUpdated;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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
