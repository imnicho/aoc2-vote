/**
 * Listens to Pterodactyl console output and translates two specific chat
 * actions into PollManager calls:
 *
 *   "* <ign> votes yes <SHORTID>"   -> polls.castVote(SHORTID, ign)
 *   "* <ign> skips <SHORTID>"       -> polls.abstain(SHORTID, ign)
 *
 * Both come from the in-game `/me` emote, which is the click-action of the
 * tellraw buttons. The IGN is authenticated by Mojang's session servers, so
 * we trust it on this path (no IP binding).
 *
 * Lines are noisy — Pterodactyl prefixes timestamps + log levels and may
 * include ANSI colour escapes. `stripConsoleNoise` reduces a line to its
 * payload before the strict regex runs.
 */

import type { PollManager } from './poll.js';

const YES_RE = /^\* (\w{3,16}) votes yes ([0-9A-HJKMNP-TV-Z]{6})\s*$/;
const SKIP_RE = /^\* (\w{3,16}) skips ([0-9A-HJKMNP-TV-Z]{6})\s*$/;
const IGN_RE = /^[A-Za-z0-9_]{3,16}$/;

const PER_IGN_LIMIT = 5;
const WINDOW_MS = 60_000;

interface RateRecord {
  count: number;
  windowStart: number;
}

export class VoteParser {
  private polls: PollManager;
  private rate = new Map<string, RateRecord>();

  constructor(polls: PollManager) {
    this.polls = polls;
  }

  /**
   * Process one raw console line. Returns the action taken, mainly for tests.
   */
  handleLine(raw: string): { kind: 'yes' | 'skip' | 'none'; ign?: string; shortId?: string; rateLimited?: boolean } {
    const stripped = stripConsoleNoise(raw);

    const yes = YES_RE.exec(stripped);
    if (yes) {
      const ign = (yes[1] ?? yes[3])!;
      const shortId = (yes[2] ?? yes[4])!;
      if (!IGN_RE.test(ign)) return { kind: 'none' };
      if (!this.allow(ign)) return { kind: 'yes', ign, shortId, rateLimited: true };
      this.polls.castVote(shortId, ign);
      return { kind: 'yes', ign, shortId };
    }

    const skip = SKIP_RE.exec(stripped);
    if (skip) {
      const ign = (skip[1] ?? skip[3])!;
      const shortId = (skip[2] ?? skip[4])!;
      if (!IGN_RE.test(ign)) return { kind: 'none' };
      if (!this.allow(ign)) return { kind: 'skip', ign, shortId, rateLimited: true };
      this.polls.abstain(shortId, ign);
      return { kind: 'skip', ign, shortId };
    }

    return { kind: 'none' };
  }

  /**
   * Soft per-IGN rate limit: 5 actions per 60s. Above the cap the parser
   * silently drops further actions until the window rolls over.
   */
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

  /** Test/debug helper. */
  rateCount(ign: string): number {
    return this.rate.get(ign.toLowerCase())?.count ?? 0;
  }
}

/**
 * Strip the Pterodactyl prefix (`[12:34:56] [main/INFO] [chat]: ` and the
 * like) plus ANSI colour escapes, leaving the message body. `/me` emotes
 * surface in console as `* <ign> <text>` so we keep that intact.
 */
export function stripConsoleNoise(line: string): string {
  let s = line;
  // ANSI colour codes
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b\[[0-9;]*m/g, '');
  // Bracketed ANSI residue without the ESC byte
  s = s.replace(/\[[0-9;]+m/g, '');
  // Strip any number of leading [bracketed] segments and optional trailing colon.
  // Examples:
  //   "[12:34:56] [main/INFO]: <body>"
  //   "[12:34:56 INFO]: <body>"
  //   "[chat]: <body>"
  while (true) {
    const next = s.replace(/^\s*\[[^\]]*\]\s*/, '');
    if (next === s) break;
    s = next;
  }
  // Drop a single leading colon (after bracketed prefixes are gone)
  s = s.replace(/^:\s*/, '');
  return s.trim();
}
