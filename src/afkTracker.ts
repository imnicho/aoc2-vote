/**
 * AFK tracking on AoC2.
 *
 * Investigation summary (2026-05-14): I audited the deployed modpack at
 * `imnicho/all-of-create` — 216 mods — and found NO AFK / away / idle /
 * tablist / nametag mod. The `Z` indicator some clients show is the vanilla
 * tab-list idle marker driven entirely by `lastActionTime` server-side; it
 * is not broadcast to console, so there is no mod-emitted line we could
 * parse. FTB Essentials is in the pack but its AFK feature is not part of
 * the NeoForge 1.21.1 port (confirmed: zero `afk` references in the live
 * `ftbessentials.snbt`).
 *
 * Consequence: the ONLY working signal on AoC2 today is the
 * console-silence idle-timeout fallback (`idleMs`, default 5 min). Activity
 * is reset by any chat line, `/me` emote, or `[<ign>: issued server
 * command:` line from the player.
 *
 * Known limitation: a player AFK-fishing / AFK-farming with an auto-clicker
 * won't produce console output, so the idle-timeout WILL eventually flag
 * them. That's the desired behaviour for poll math (they aren't reactive
 * even if they're technically in-world), but it means there's a 5-minute
 * lag between a player going inactive and the denominator shrinking. The
 * regex patterns below are kept for forward-compat: if a future pack ever
 * does ship an AFK mod that emits a console line in one of these common
 * shapes, the tracker will automatically pick it up. As of today they
 * never fire on AoC2 — they are speculative, not load-bearing.
 */
import { stripConsoleNoise } from './voteParser.js';
import type { Roster } from './roster.js';

// Speculative — no current AoC2 mod emits these. Forward-compat only; if a
// future pack adds an AFK mod whose broadcast resembles "<ign> is now AFK"
// the tracker will pick it up automatically. Kept lenient to tolerate style
// codes (`§7`/`§r`) which are stripped before matching.
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
    // Default disabled (Number.POSITIVE_INFINITY). AoC2 has no AFK mod, so
    // chat-silence ≠ AFK — players are routinely silent for hours during
    // normal play. Marking them AFK collapses poll denominators and causes
    // polls to instant-execute. Re-enable via env if a real AFK mod is added
    // to the pack later.
    this.idleMs = opts.idleMs ?? Number.POSITIVE_INFINITY;
    this.sweepMs = opts.sweepMs ?? 30_000;
  }

  start(): void {
    if (this.sweepTimer) return;
    // Skip the sweep entirely when idle-timeout is disabled.
    if (!Number.isFinite(this.idleMs)) return;
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
