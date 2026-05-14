/**
 * AFK tracking with two signal sources:
 *
 *  1. Console-line patterns (FTB Essentials and similar) — preferred, since
 *     they reflect the mod's own AFK detection.
 *  2. Idle-timeout fallback — any chat / vote / command activity from a
 *     player resets their last-activity timestamp; after `idleMs` of silence
 *     they're marked AFK.
 *
 * Both routes write into the shared `Roster` AFK set. The poll math reads
 * `roster.activeCount()` (online − afk) as the vote denominator so AFK
 * players can't stall a poll.
 */
import { stripConsoleNoise } from './voteParser.js';
import type { Roster } from './roster.js';

// "<ign> is now AFK" / "is no longer AFK" / "is now afk" variants. Some mods
// wrap the body in style codes (§7) which `stripConsoleNoise` does not
// remove on its own; the regex tolerates a leading non-word prefix.
// Lenient AFK on/off patterns — many mods wrap the body in style/colour
// codes (e.g. FTB Essentials prepends `§7` and trails `§r`). Allow short
// non-word leading runs and arbitrary trailing content after the keyword.
const AFK_ON_RE = /^\W{0,8}(\w{3,16}) (?:is now|went|has gone) AFK\b/i;
const AFK_OFF_RE = /^\W{0,8}(\w{3,16}) (?:is no longer|is back from|returned from|came back from) AFK\b/i;
const CHAT_RE = /^<(\w{3,16})>\s/;
const COMMAND_ISSUED_RE = /^\[?(\w{3,16})(?:: issued server command:|: ran command|]\s*issued (?:server)? ?command)/i;
const ME_EMOTE_RE = /^\* (\w{3,16}) /;

const IGN_RE = /^[A-Za-z0-9_]{3,16}$/;

export interface AfkTrackerOptions {
  /** Idle threshold in ms. After this much silence a player is marked AFK. */
  idleMs?: number;
  /** Sweep interval in ms for the idle-timeout checker. */
  sweepMs?: number;
}

export class AfkTracker {
  private readonly roster: Roster;
  private readonly idleMs: number;
  private readonly sweepMs: number;
  private readonly lastActivity = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(roster: Roster, opts: AfkTrackerOptions = {}) {
    this.roster = roster;
    this.idleMs = opts.idleMs ?? 5 * 60 * 1000;
    this.sweepMs = opts.sweepMs ?? 30_000;
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Feed one raw console line. Updates AFK state via mod-emitted patterns or
   * the last-activity timestamp.
   */
  handleLine(raw: string): void {
    // Drop Minecraft style/colour codes (`§<x>`) before matching — many mods
    // (FTB Essentials in particular) wrap broadcast bodies in them.
    const stripped = stripConsoleNoise(raw).replace(/§./g, '').trim();

    const off = AFK_OFF_RE.exec(stripped);
    if (off && off[1] && IGN_RE.test(off[1])) {
      this.recordActivity(off[1]);
      return;
    }

    const on = AFK_ON_RE.exec(stripped);
    if (on && on[1] && IGN_RE.test(on[1])) {
      this.roster.markAfk(on[1]);
      // Don't reset their activity timestamp — they're AFK now; the
      // idle-timeout shouldn't immediately flip them back.
      return;
    }

    const chat = CHAT_RE.exec(stripped);
    if (chat && chat[1] && IGN_RE.test(chat[1])) {
      this.recordActivity(chat[1]);
      return;
    }

    const cmd = COMMAND_ISSUED_RE.exec(stripped);
    if (cmd && cmd[1] && IGN_RE.test(cmd[1])) {
      this.recordActivity(cmd[1]);
      return;
    }

    const emote = ME_EMOTE_RE.exec(stripped);
    if (emote && emote[1] && IGN_RE.test(emote[1])) {
      this.recordActivity(emote[1]);
      return;
    }
  }

  /**
   * Explicitly record activity for an IGN (called from join events,
   * vote/skip parser hooks, dashboard-command hook). Clears AFK flag.
   */
  recordActivity(ign: string): void {
    if (!IGN_RE.test(ign)) return;
    const key = ign.toLowerCase();
    this.lastActivity.set(key, Date.now());
    this.roster.markActive(ign);
  }

  /** Test/debug helper. */
  lastActivityAt(ign: string): number | undefined {
    return this.lastActivity.get(ign.toLowerCase());
  }

  private sweep(): void {
    const now = Date.now();
    for (const player of this.roster.get()) {
      const key = player.toLowerCase();
      const last = this.lastActivity.get(key);
      if (last === undefined) {
        // Seed activity at first sight so a fresh join doesn't get
        // immediately flagged AFK by the sweep.
        this.lastActivity.set(key, now);
        continue;
      }
      if (now - last >= this.idleMs) {
        this.roster.markAfk(player);
      }
    }
    // Drop activity entries for players who left.
    const online = new Set(this.roster.get().map((p) => p.toLowerCase()));
    for (const k of this.lastActivity.keys()) {
      if (!online.has(k)) this.lastActivity.delete(k);
    }
  }
}
