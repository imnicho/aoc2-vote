/**
 * Listens to Pterodactyl console output for the `/dashboard` command (logger line; or the legacy
 * `/me dashboards?` emote) and replies with a fresh welcome tellraw to the
 * requesting player.
 */
import { stripConsoleNoise } from './voteParser.js';
import type { Roster } from './roster.js';
import type { WelcomeFlow } from './welcomeFlow.js';

// v0.2+ mod logger line: `[aoc2-dashboard] nicho requested dashboard`
// v0.1 emote fallback: `* nicho dashboard`
const DASHBOARD_RE = /^(?:\[aoc2-dashboard\] (\w{3,16}) requested dashboard|\* (\w{3,16}) dashboards?)\s*$/;
const IGN_RE = /^[A-Za-z0-9_]{3,16}$/;
const PER_IGN_LIMIT = 3;
const WINDOW_MS = 60_000;

interface RateRecord {
  count: number;
  windowStart: number;
}

export class DashboardCommandParser {
  private readonly roster: Roster;
  private readonly welcome: WelcomeFlow;
  private rate = new Map<string, RateRecord>();

  constructor(roster: Roster, welcome: WelcomeFlow) {
    this.roster = roster;
    this.welcome = welcome;
  }

  handleLine(raw: string): {
    kind: 'dashboard' | 'none';
    ign?: string;
    rateLimited?: boolean;
  } {
    const stripped = stripConsoleNoise(raw);
    const m = DASHBOARD_RE.exec(stripped);
    if (!m) return { kind: 'none' };
    const ign = m[1] ?? m[2] ?? '';
    if (!IGN_RE.test(ign)) return { kind: 'none' };
    // roster.has and the rate-limit map both normalize case internally,
    // but pass the original-case ign to dispatch so the tellraw selector
    // (`@a[name=<ign>]`) targets the correct Minecraft player profile.
    if (!this.roster.has(ign)) return { kind: 'none' };
    if (!this.allow(ign)) return { kind: 'dashboard', ign, rateLimited: true };
    this.welcome.dispatch(ign, 'command').catch(() => undefined);
    return { kind: 'dashboard', ign };
  }

  private allow(ign: string): boolean {
    const key = ign.toLowerCase();
    const now = Date.now();
    const rec = this.rate.get(key);
    if (!rec || now - rec.windowStart >= WINDOW_MS) {
      this.rate.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (rec.count >= PER_IGN_LIMIT) return false;
    rec.count += 1;
    return true;
  }

  rateCount(ign: string): number {
    return this.rate.get(ign.toLowerCase())?.count ?? 0;
  }
}
