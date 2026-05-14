import type { Config } from './config.js';
import type { PteroClient } from './ptero.js';
import type { Roster } from './roster.js';
import { signSessionToken } from './sessionToken.js';

const IGN_RE = /^[A-Za-z0-9_]{3,16}$/;

export interface WelcomeFlowDeps {
  cfg: Config;
  roster: Roster;
  ptero: PteroClient;
}

/**
 * Subscribes to roster join events. For each join, mints a single-use 5-min
 * mint token and dispatches a private `tellraw @a[name=<ign>] [...]` so only
 * that player sees the dashboard link.
 */
export class WelcomeFlow {
  private readonly cfg: Config;
  private readonly roster: Roster;
  private readonly ptero: PteroClient;
  private readonly allowed: Set<string>;
  private unsub: (() => void) | null = null;
  // Per-IGN dedupe so a re-fired `/dashboard` (panel ws bounce, duplicate
  // console listener, double-tap of the command) doesn't emit two tellraws.
  private readonly lastDispatch = new Map<string, number>();
  private static readonly DEDUPE_MS = 3000;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(deps: WelcomeFlowDeps) {
    this.cfg = deps.cfg;
    this.roster = deps.roster;
    this.ptero = deps.ptero;
    this.allowed = new Set(deps.cfg.OPERATOR_IGNS.map((s) => s.toLowerCase()));
  }

  start(): void {
    if (this.unsub) return;
    this.unsub = this.roster.onPlayerJoin((ign) => {
      this.dispatch(ign).catch((err) => logErr('dispatch', err));
    });
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), 30_000);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Mint a token and send the welcome tellraw to `ign`. Exposed so the
   * dashboard-command parser can reuse the same path. Returns the issued URL
   * (without the token) when dispatched, or null when skipped (including
   * skipped-due-to-dedupe).
   */
  async dispatch(ign: string): Promise<string | null> {
    if (!IGN_RE.test(ign)) return null;
    if (!this.cfg.SESSION_SECRET) return null;
    if (!this.cfg.PUBLIC_BASE_URL) return null;

    const key = ign.toLowerCase();
    const now = Date.now();
    const last = this.lastDispatch.get(key) ?? 0;
    if (now - last < WelcomeFlow.DEDUPE_MS) return null;
    this.lastDispatch.set(key, now);

    const isOperator = this.allowed.has(key);
    const signed = signSessionToken(
      'mint',
      ign,
      isOperator,
      this.cfg.SESSION_SECRET,
      this.cfg.MINT_TTL_MS,
    );
    const url = `${this.cfg.PUBLIC_BASE_URL}/aoc2/vote?t=${signed.token}`;

    const components = buildWelcomeComponents(ign, url);
    const cmd = `tellraw @a[name=${ign}] ${JSON.stringify(components)}`;

    if (this.cfg.PTERO_DRY_RUN) {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] welcome link for ${ign}: ${url}`);
    }

    try {
      await this.ptero.runCommand(cmd);
    } catch (err) {
      logErr('tellraw', err);
    }
    return url;
  }

  private sweep(): void {
    const cutoff = Date.now() - WelcomeFlow.DEDUPE_MS;
    for (const [k, t] of this.lastDispatch) {
      if (t < cutoff) this.lastDispatch.delete(k);
    }
  }
}

export function buildWelcomeComponents(ign: string, url: string): unknown[] {
  // Differentiate components by colour only — bold is explicitly off on every
  // entry so Minecraft's style-inheritance can't leak weight into later
  // components. Brackets carry no inner spaces.
  return [
    { text: '[AOC2] ', color: 'gold', bold: false },
    { text: 'Welcome, ', bold: false },
    { text: ign, color: 'yellow', bold: false },
    { text: '. ', bold: false },
    {
      text: '[open dashboard ↗]',
      color: 'aqua',
      bold: false,
      clickEvent: { action: 'open_url', value: url },
      hoverEvent: { action: 'show_text', contents: 'log in to the community dashboard' },
    },
    { text: ' or type ', bold: false },
    { text: '/dashboard', color: 'aqua', bold: false },
    { text: '.', bold: false },
  ];
}

function logErr(label: string, err: unknown): void {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const trimmed = message.replace(/(Pterodactyl [^:]+:\s*\d+)\s.*/s, '$1');
  // eslint-disable-next-line no-console
  console.error(`[welcome] ${label}: ${trimmed}`);
}
