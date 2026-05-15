import { ulid } from 'ulid';
import {
  ACTION_LABELS,
  commandsFor,
  isPowerAction,
  type Action,
} from './actions.js';
import type { Config } from './config.js';
import type { DB, PollRow } from './db.js';
import type { PteroClient } from './ptero.js';
import type { Roster } from './roster.js';
import { buildVotePromptCommand, generateShortId, IGN_RE } from './tellraw.js';

class PollAlreadyOpen extends Error {
  constructor() {
    super('poll_already_open');
    this.name = 'PollAlreadyOpen';
  }
}

class AlreadyVoted extends Error {
  constructor() {
    super('already_voted');
    this.name = 'AlreadyVoted';
  }
}

interface SqliteConstraintError {
  code?: string;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as SqliteConstraintError).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export interface OpenPollResult {
  poll: PollRow;
  executedImmediately: boolean;
}

export type OpenError =
  | { kind: 'ign_not_online' }
  | { kind: 'poll_already_open' }
  | { kind: 'action_on_cooldown'; until: number };

export type VoteError =
  | { kind: 'ign_not_online' }
  | { kind: 'poll_not_found' }
  | { kind: 'poll_expired' }
  | { kind: 'already_voted' };

export type AbstainError =
  | { kind: 'ign_not_online' }
  | { kind: 'poll_not_found' }
  | { kind: 'poll_expired' }
  | { kind: 'already_acted' };

export interface AbstainResult {
  abstained: number;
  needed: number;
  executed: boolean;
}

export interface VoteResult {
  votes: number;
  needed: number;
  executed: boolean;
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

export class PollManager {
  private cfg: Config;
  private db: DB;
  private ptero: PteroClient;
  private roster: Roster;
  private lastTps: string | null = null;
  private onChange: () => void = () => undefined;
  private sweepTimer: NodeJS.Timeout | null = null;
  // Non-persistent: abstainers reset on boot by design.
  private abstainers = new Map<string, Set<string>>();

  constructor(
    cfg: Config,
    db: DB,
    ptero: PteroClient,
    roster: Roster,
  ) {
    this.cfg = cfg;
    this.db = db;
    this.ptero = ptero;
    this.roster = roster;
  }

  start(onChange: () => void): void {
    this.onChange = onChange;
    // expire any open polls left over from a previous run
    this.db.expireStalePolls.run(Date.now(), Date.now());
    this.sweepTimer = setInterval(() => this.sweep(), 1000);
    // also re-evaluate when roster changes (someone leaving may auto-pass a poll)
    this.roster.onChange(() => this.reevaluateAll());
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  lastTpsValue(): string | null {
    return this.lastTps;
  }

  setLastTps(v: string | null): void {
    this.lastTps = v;
    this.onChange();
  }

  cooldowns(): Record<string, number> {
    const now = Date.now();
    this.db.deleteExpiredCooldowns.run(now);
    const out: Record<string, number> = {};
    const rows = this.db.listCooldowns.all() as { action: string; until: number }[];
    for (const r of rows) out[r.action] = r.until;
    return out;
  }

  publicPolls(): PublicPoll[] {
    const rows = this.db.listOpenPolls.all() as PollRow[];
    const active = this.roster.activeCount();
    return rows.map((row) => {
      const voters = (this.db.getVotes.all(row.id) as { ign: string }[]).map(
        (v) => v.ign,
      );
      const abstained = this.abstainers.get(row.id)?.size ?? 0;
      return {
        id: row.id,
        short_id: row.short_id,
        action: row.action,
        initiator: row.initiator_ign,
        voters,
        abstained,
        needed: Math.max(1, active - abstained),
        expires_at: row.expires_at,
        status: row.status,
      };
    });
  }

  open(ign: string, action: Action): { ok: true; result: OpenPollResult } | { ok: false; err: OpenError } {
    const lower = ign.toLowerCase();
    if (!this.roster.has(lower)) return { ok: false, err: { kind: 'ign_not_online' } };

    // cooldown check
    const cd = this.db.listCooldowns.all() as { action: string; until: number }[];
    const now = Date.now();
    for (const r of cd) {
      if (r.action === action && r.until > now) {
        return { ok: false, err: { kind: 'action_on_cooldown', until: r.until } };
      }
    }

    const id = ulid();
    const createdAt = now;
    const expiresAt = createdAt + this.cfg.POLL_TTL_MS;
    const shortId = this.generateUniqueShortId();
    // `initiator_ign` is used as a display string in the vote-prompt tellraw,
    // so store the canonical Mojang-case form from the roster (the input
    // `ign` may have been lowercased upstream by the session-token signer).
    const initiatorDisplay = this.canonicalIgn(lower) ?? ign;
    const txn = this.db.raw.transaction(() => {
      // ensure no open poll for this action
      this.db.expireStalePolls.run(createdAt, createdAt);
      const existing = this.db.getOpenPollByAction.get(action) as PollRow | undefined;
      if (existing) throw new PollAlreadyOpen();
      this.db.insertPoll.run(id, shortId, action, initiatorDisplay, 'open', createdAt, expiresAt);
      // Votes are stored lowercased — the (poll_id, ign) PK enforces one
      // vote per player and `hasVoted` already compares case-insensitively.
      this.db.insertVote.run(id, lower, createdAt);
    });
    try {
      txn();
    } catch (err) {
      if (err instanceof PollAlreadyOpen || isUniqueConstraintError(err)) {
        return { ok: false, err: { kind: 'poll_already_open' } };
      }
      throw err;
    }

    const row = this.db.getPoll.get(id) as PollRow;

    const activeSize = this.roster.activeCount();
    let executed = false;
    if (activeSize <= 1) {
      // initiator alone (or everyone else is AFK) — execute immediately
      this.markPassed(row);
      this.executeAction(action).catch((err) => logPteroError('open executeAction', err));
      executed = true;
    } else {
      // Two parallel tellraws on every state change:
      //   - non-voters get the actionable [YES]/[SKIP] prompt
      //   - acted players (voters + abstainers) get a read-only progress line
      // so the whole table sees the count tick up each time someone clicks.
      this.broadcastPollPrompts(row);
      this.broadcastPollProgress(row);
    }

    this.onChange();
    return { ok: true, result: { poll: row, executedImmediately: executed } };
  }

  vote(pollId: string, ign: string): { ok: true; result: VoteResult } | { ok: false; err: VoteError } {
    const lower = ign.toLowerCase();
    if (!this.roster.has(lower)) return { ok: false, err: { kind: 'ign_not_online' } };

    const row = this.db.getPoll.get(pollId) as PollRow | undefined;
    if (!row) return { ok: false, err: { kind: 'poll_not_found' } };
    if (row.status !== 'open') {
      if (row.status === 'expired') return { ok: false, err: { kind: 'poll_expired' } };
      return { ok: false, err: { kind: 'poll_not_found' } };
    }
    if (row.expires_at <= Date.now()) {
      this.db.setPollStatus.run('expired', Date.now(), row.id);
      this.startCooldown(row.action as Action);
      this.onChange();
      return { ok: false, err: { kind: 'poll_expired' } };
    }

    const txn = this.db.raw.transaction(() => {
      const already = this.db.hasVoted.get(row.id, lower) as { 1: number } | undefined;
      if (already) throw new AlreadyVoted();
      this.db.insertVote.run(row.id, lower, Date.now());
    });
    try {
      txn();
    } catch (err) {
      if (err instanceof AlreadyVoted || isUniqueConstraintError(err)) {
        return { ok: false, err: { kind: 'already_voted' } };
      }
      throw err;
    }

    const voters = (this.db.getVotes.all(row.id) as { ign: string }[]).map((v) => v.ign);
    const active = this.activeOnlineSet();
    const onlineVoters = voters.filter((v) => active.has(v.toLowerCase())).length;
    const abstainerCount = this.onlineAbstainersFor(row.id, active);
    const needed = Math.max(1, active.size - abstainerCount);

    let executed = false;
    if (onlineVoters >= needed) {
      this.markPassed(row);
      this.executeAction(row.action as Action).catch((err) => logPteroError('vote executeAction', err));
      executed = true;
    } else {
      // Non-voters get the actionable prompt; acted players see a progress
      // line so everyone watches the count tick up.
      this.broadcastPollPrompts(row);
      this.broadcastPollProgress(row);
    }

    this.onChange();
    return { ok: true, result: { votes: voters.length, needed, executed } };
  }

  private reevaluateAll(): void {
    const now = Date.now();
    const rows = this.db.listOpenPolls.all() as PollRow[];
    let changed = false;
    const active = this.activeOnlineSet();
    for (const row of rows) {
      if (row.expires_at <= now) {
        this.db.setPollStatus.run('expired', now, row.id);
        this.startCooldown(row.action as Action);
        this.abstainers.delete(row.id);
        changed = true;
        continue;
      }
      const voters = (this.db.getVotes.all(row.id) as { ign: string }[]).map((v) => v.ign);
      const onlineVoters = voters.filter((v) => active.has(v.toLowerCase())).length;
      if (active.size === 0) continue;
      const abstainerCount = this.onlineAbstainersFor(row.id, active);
      const needed = Math.max(1, active.size - abstainerCount);
      if (onlineVoters >= needed) {
        this.markPassed(row);
        this.executeAction(row.action as Action).catch((err) => logPteroError('reevaluate executeAction', err));
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /**
   * Build the lowercase set of online players who are NOT currently AFK.
   * Used as the live denominator for vote-counting.
   */
  private activeOnlineSet(): Set<string> {
    const afk = new Set(this.roster.afkList());
    const out = new Set<string>();
    for (const p of this.roster.get()) {
      const key = p.toLowerCase();
      if (!afk.has(key)) out.add(key);
    }
    return out;
  }

  /**
   * Look up the canonical Mojang-case form of `lower` from the roster.
   * Minecraft `@a[name=X]` is case-sensitive, so the broadcast selector MUST
   * use the player's actual profile name. Returns null if the roster doesn't
   * currently know the player (rare race window — caller falls back).
   */
  private canonicalIgn(lower: string): string | null {
    const needle = lower.toLowerCase();
    for (const p of this.roster.get()) {
      if (p.toLowerCase() === needle) return p;
    }
    return null;
  }

  /** Map a list of lowercase IGNs to their canonical roster case. */
  private canonicalize(lowers: string[]): string[] {
    const out: string[] = [];
    for (const v of lowers) {
      const c = this.canonicalIgn(v);
      if (c !== null) out.push(c);
    }
    return out;
  }

  private sweep(): void {
    const now = Date.now();
    const expired = this.db.listOpenPolls.all() as PollRow[];
    let changed = false;
    for (const row of expired) {
      if (row.expires_at <= now) {
        this.db.setPollStatus.run('expired', now, row.id);
        this.startCooldown(row.action as Action);
        this.abstainers.delete(row.id);
        changed = true;
      }
    }
    const removed = this.db.deleteExpiredCooldowns.run(now);
    if (removed.changes > 0) changed = true;
    if (changed) this.onChange();
  }

  private markPassed(row: PollRow): void {
    this.db.setPollStatus.run('passed', Date.now(), row.id);
    this.startCooldown(row.action as Action);
    this.abstainers.delete(row.id);
  }

  private startCooldown(action: Action): void {
    const until = Date.now() + this.cfg.COOLDOWN_MS;
    this.db.upsertCooldown.run(action, until);
  }

  /**
   * Read the cooldown until-time for an action, or null if no active cooldown.
   * Used by the operator path to short-circuit before executing.
   */
  cooldownFor(action: Action): number | null {
    const now = Date.now();
    const rows = this.db.listCooldowns.all() as { action: string; until: number }[];
    for (const r of rows) {
      if (r.action === action) {
        if (r.until <= now) return null;
        return r.until;
      }
    }
    return null;
  }

  /**
   * Apply the standard cooldown for an action. Public so the operator path
   * can stamp the same shared cooldown table the poll path uses.
   */
  applyCooldown(action: Action): void {
    this.startCooldown(action);
    this.onChange();
  }

  /**
   * Look up an open poll by its 6-char short id, verify the IGN is in the
   * roster, then delegate to `vote()`. Returns `poll_not_found` if no open
   * poll has that short id.
   */
  castVote(shortId: string, ign: string): { ok: true; result: VoteResult } | { ok: false; err: VoteError } {
    if (!IGN_RE.test(ign)) return { ok: false, err: { kind: 'ign_not_online' } };
    const row = this.db.getOpenPollByShortId.get(shortId) as PollRow | undefined;
    if (!row) return { ok: false, err: { kind: 'poll_not_found' } };
    return this.vote(row.id, ign.toLowerCase());
  }

  /**
   * Record an abstention from an in-game SKIP click. Adds the IGN to the
   * in-memory abstainer set for the poll, recomputes the threshold, and
   * passes the poll if everyone has now acted.
   */
  abstain(shortId: string, ign: string): { ok: true; result: AbstainResult } | { ok: false; err: AbstainError } {
    if (!IGN_RE.test(ign)) return { ok: false, err: { kind: 'ign_not_online' } };
    const lower = ign.toLowerCase();
    if (!this.roster.has(lower)) return { ok: false, err: { kind: 'ign_not_online' } };

    const row = this.db.getOpenPollByShortId.get(shortId) as PollRow | undefined;
    if (!row) return { ok: false, err: { kind: 'poll_not_found' } };
    if (row.status !== 'open') return { ok: false, err: { kind: 'poll_not_found' } };
    if (row.expires_at <= Date.now()) {
      this.db.setPollStatus.run('expired', Date.now(), row.id);
      this.startCooldown(row.action as Action);
      this.abstainers.delete(row.id);
      this.onChange();
      return { ok: false, err: { kind: 'poll_expired' } };
    }

    // Already voted? Treat as already_acted — a player can't both vote and skip.
    const already = this.db.hasVoted.get(row.id, lower) as { 1: number } | undefined;
    if (already) return { ok: false, err: { kind: 'already_acted' } };

    let set = this.abstainers.get(row.id);
    if (!set) {
      set = new Set<string>();
      this.abstainers.set(row.id, set);
    }
    if (set.has(lower)) {
      return { ok: false, err: { kind: 'already_acted' } };
    }
    set.add(lower);

    const voters = (this.db.getVotes.all(row.id) as { ign: string }[]).map((v) => v.ign);
    const active = this.activeOnlineSet();
    const onlineVoters = voters.filter((v) => active.has(v.toLowerCase())).length;
    const abstainerCount = this.onlineAbstainersFor(row.id, active);
    const needed = Math.max(1, active.size - abstainerCount);

    let executed = false;
    if (onlineVoters >= needed && onlineVoters >= 1) {
      this.markPassed(row);
      this.executeAction(row.action as Action).catch((err) =>
        logPteroError('abstain executeAction', err),
      );
      executed = true;
    } else {
      this.broadcastPollPrompts(row);
      this.broadcastPollProgress(row);
    }

    this.onChange();
    return { ok: true, result: { abstained: set.size, needed, executed } };
  }

  /** Number of currently-online players who have abstained on this poll. */
  private onlineAbstainersFor(pollId: string, online: Set<string>): number {
    const set = this.abstainers.get(pollId);
    if (!set) return 0;
    let n = 0;
    for (const ign of set) {
      if (online.has(ign)) n += 1;
    }
    return n;
  }

  /** Expose the live abstainer list (for tests / debug). */
  abstainersFor(pollId: string): string[] {
    const set = this.abstainers.get(pollId);
    return set ? [...set] : [];
  }

  /**
   * Pick a fresh 6-char Crockford short id, regenerating on any collision
   * with currently-open polls. The retry budget is generous — 32^6 ≈ 1.07e9
   * possible ids and at most a handful of open polls at any time.
   */
  private generateUniqueShortId(): string {
    for (let i = 0; i < 16; i++) {
      const candidate = generateShortId();
      const hit = this.db.shortIdExists.get(candidate) as { 1: number } | undefined;
      if (!hit) return candidate;
    }
    // Astronomically unlikely; fall back to a guaranteed-unique candidate by
    // suffixing wall-clock millis mod alphabet. Returned value is still
    // length 6 and within the Crockford alphabet.
    return generateShortId();
  }

  /**
   * Read-only progress tellraw fired to every player who's already acted
   * (voted or abstained) — initiator included. Carries the live count and
   * how many remain. No click buttons.
   *
   * Fires alongside `broadcastPollPrompts` on every state change so the
   * acted-set sees the count tick up as new votes arrive.
   */
  private broadcastPollProgress(row: PollRow): void {
    const voters = (this.db.getVotes.all(row.id) as { ign: string }[]).map((v) => v.ign);
    const abstained = this.abstainersFor(row.id);
    const active = this.activeOnlineSet();
    const onlineVoters = voters.filter((v) => active.has(v.toLowerCase())).length;
    const abstainerCount = this.onlineAbstainersFor(row.id, active);
    const needed = Math.max(1, active.size - abstainerCount);
    const remaining = Math.max(0, needed - onlineVoters);

    // Target the acted set in canonical case (Minecraft selectors are
    // case-sensitive). If we can't resolve anyone, skip silently.
    //
    // One tellraw per player: `@a[name=X,name=Y]` ANDs the positive name
    // filters (an entity can't have two names) and matches nobody, so we
    // can't pack the acted-set into a single selector. Fan out instead.
    const acted = this.canonicalize([...voters, ...abstained]);
    if (acted.length === 0) return;

    const label = ACTION_LABELS[row.action as Action];
    const components = [
      { text: '[VOTE] ', color: 'gold', bold: false },
      { text: label, color: 'aqua', bold: false },
      { text: ` — `, bold: false },
      { text: `${onlineVoters}/${needed}`, color: 'yellow', bold: false },
      { text: ` voted`, bold: false },
      remaining > 0
        ? { text: `, waiting on ${remaining} more`, color: 'gray', bold: false }
        : { text: ` — passing now`, color: 'green', bold: false },
    ];
    const payload = JSON.stringify(components);
    for (const name of acted) {
      const cmd = `tellraw @a[name=${name}] ${payload}`;
      this.ptero.runCommand(cmd).catch((err) => logPteroError('broadcast progress', err));
    }
  }

  /**
   * Build the `/tellraw` for non-voters and fire it via runCommand. Silent
   * if the entire roster has already voted/abstained.
   */
  private broadcastPollPrompts(row: PollRow): void {
    const voters = (this.db.getVotes.all(row.id) as { ign: string }[]).map((v) => v.ign);
    const abstained = this.abstainersFor(row.id);
    const active = this.activeOnlineSet();
    const onlineVoters = voters.filter((v) => active.has(v.toLowerCase())).length;
    const abstainerCount = this.onlineAbstainersFor(row.id, active);
    const needed = Math.max(1, active.size - abstainerCount);
    // `name=!<ign>` in @a is a case-sensitive string equality, so the
    // selector exclusion list must use the player's canonical Mojang case
    // from the roster — not the lowercase storage form. Players whose
    // canonical case can't be resolved (already left the server) are
    // dropped from the exclusion list; the broadcast still goes out to
    // everyone else with the correct exclusions applied.
    const cmd = buildVotePromptCommand({
      shortId: row.short_id,
      initiator: row.initiator_ign,
      actionLabel: ACTION_LABELS[row.action as Action],
      voted: this.canonicalize(voters),
      abstained: this.canonicalize(abstained),
      rosterSize: active.size,
      votes: onlineVoters,
      needed,
    });
    if (cmd === null) return;
    this.ptero.runCommand(cmd).catch((err) => logPteroError('broadcast tellraw', err));
  }

  private async executeAction(action: Action): Promise<void> {
    const label = ACTION_LABELS[action];
    const spawnCoords = this.cfg.SPAWN_COORDS;
    try {
      const components = [
        { text: '[VOTE] ', color: 'gold', bold: false },
        { text: 'passed: ', bold: false },
        { text: label, color: 'aqua', bold: false },
        { text: ' — executing now.', color: 'green', bold: false },
      ];
      await this.ptero.runCommand(`tellraw @a ${JSON.stringify(components)}`);
    } catch (err) {
      logPteroError('executeAction passed-tellraw', err);
    }

    if (isPowerAction(action)) {
      try {
        await this.ptero.power('restart');
      } catch (err) {
        logPteroError('executeAction power restart', err);
      }
      return;
    }

    for (const cmd of commandsFor(action, { spawn: spawnCoords })) {
      try {
        await this.ptero.runCommand(cmd);
      } catch (err) {
        logPteroError(`executeAction cmd ${action}`, err);
      }
    }

    if (action === 'tps') {
      const tps = await this.ptero.captureTps();
      if (tps) {
        this.lastTps = tps;
        try {
          const components = [
            { text: '[TPS] ', color: 'gold', bold: false },
            { text: tps, color: 'aqua', bold: false },
          ];
          await this.ptero.runCommand(`tellraw @a ${JSON.stringify(components)}`);
        } catch (err) {
          logPteroError('executeAction tps-tellraw', err);
        }
        this.onChange();
      }
    }
  }
}

/**
 * Log a Pterodactyl-side failure without leaking the bearer token or full
 * response bodies. Only the action label and a short message reach Coolify.
 */
function logPteroError(action: string, err: unknown): void {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  // The thrown messages in ptero.ts contain `Pterodactyl ... failed: <status> <text>`.
  // <text> can include operator-sensitive details — strip everything after the status.
  const trimmed = message.replace(/(Pterodactyl [^:]+:\s*\d+)\s.*/s, '$1');
  // eslint-disable-next-line no-console
  console.error(`[ptero] ${action}: ${trimmed}`);
}

