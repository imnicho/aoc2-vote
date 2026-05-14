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

export interface VoteResult {
  votes: number;
  needed: number;
  executed: boolean;
}

export interface PublicPoll {
  id: string;
  action: string;
  initiator: string;
  voters: string[];
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

  constructor(cfg: Config, db: DB, ptero: PteroClient, roster: Roster) {
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
    const onlineSize = this.roster.size();
    return rows.map((row) => {
      const voters = (this.db.getVotes.all(row.id) as { ign: string }[]).map(
        (v) => v.ign,
      );
      return {
        id: row.id,
        action: row.action,
        initiator: row.initiator_ign,
        voters,
        needed: Math.max(1, onlineSize),
        expires_at: row.expires_at,
        status: row.status,
      };
    });
  }

  open(ign: string, action: Action): { ok: true; result: OpenPollResult } | { ok: false; err: OpenError } {
    if (!this.roster.has(ign)) return { ok: false, err: { kind: 'ign_not_online' } };

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
    const txn = this.db.raw.transaction(() => {
      // ensure no open poll for this action
      this.db.expireStalePolls.run(createdAt, createdAt);
      const existing = this.db.getOpenPollByAction.get(action) as PollRow | undefined;
      if (existing) throw new PollAlreadyOpen();
      this.db.insertPoll.run(id, action, ign, 'open', createdAt, expiresAt);
      this.db.insertVote.run(id, ign, createdAt);
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

    const onlineSize = this.roster.size();
    let executed = false;
    if (onlineSize <= 1) {
      // initiator alone — execute immediately
      this.markPassed(row);
      this.executeAction(action).catch((err) => logPteroError('open executeAction', err));
      executed = true;
    } else {
      // announce
      const label = ACTION_LABELS[action];
      const msg = `${ign} has voted to ${label}. Vote at https://nicho.wtf/aoc2/vote (1/${onlineSize})`;
      this.ptero.runCommand(`say ${sanitizeSayText(msg)}`).catch((err) => logPteroError('open say', err));
    }

    this.onChange();
    return { ok: true, result: { poll: row, executedImmediately: executed } };
  }

  vote(pollId: string, ign: string): { ok: true; result: VoteResult } | { ok: false; err: VoteError } {
    if (!this.roster.has(ign)) return { ok: false, err: { kind: 'ign_not_online' } };

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
      const already = this.db.hasVoted.get(row.id, ign) as { 1: number } | undefined;
      if (already) throw new AlreadyVoted();
      this.db.insertVote.run(row.id, ign, Date.now());
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
    const online = new Set(this.roster.get().map((p) => p.toLowerCase()));
    const onlineVoters = voters.filter((v) => online.has(v.toLowerCase())).length;
    const needed = Math.max(1, online.size);

    let executed = false;
    if (onlineVoters >= needed) {
      this.markPassed(row);
      this.executeAction(row.action as Action).catch((err) => logPteroError('vote executeAction', err));
      executed = true;
    } else {
      const label = ACTION_LABELS[row.action as Action];
      const msg = `${ign} has voted to ${label}. Vote at https://nicho.wtf/aoc2/vote (${onlineVoters}/${needed})`;
      this.ptero.runCommand(`say ${sanitizeSayText(msg)}`).catch((err) => logPteroError('vote say', err));
    }

    this.onChange();
    return { ok: true, result: { votes: voters.length, needed, executed } };
  }

  private reevaluateAll(): void {
    const now = Date.now();
    const rows = this.db.listOpenPolls.all() as PollRow[];
    let changed = false;
    const online = new Set(this.roster.get().map((p) => p.toLowerCase()));
    const needed = Math.max(1, online.size);
    for (const row of rows) {
      if (row.expires_at <= now) {
        this.db.setPollStatus.run('expired', now, row.id);
        this.startCooldown(row.action as Action);
        changed = true;
        continue;
      }
      const voters = (this.db.getVotes.all(row.id) as { ign: string }[]).map((v) => v.ign);
      const onlineVoters = voters.filter((v) => online.has(v.toLowerCase())).length;
      if (online.size === 0) continue;
      if (onlineVoters >= needed) {
        this.markPassed(row);
        this.executeAction(row.action as Action).catch((err) => logPteroError('reevaluate executeAction', err));
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  private sweep(): void {
    const now = Date.now();
    const expired = this.db.listOpenPolls.all() as PollRow[];
    let changed = false;
    for (const row of expired) {
      if (row.expires_at <= now) {
        this.db.setPollStatus.run('expired', now, row.id);
        this.startCooldown(row.action as Action);
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
  }

  private startCooldown(action: Action): void {
    const until = Date.now() + this.cfg.COOLDOWN_MS;
    this.db.upsertCooldown.run(action, until);
  }

  private async executeAction(action: Action): Promise<void> {
    const label = ACTION_LABELS[action];
    try {
      await this.ptero.runCommand(`say ${sanitizeSayText(`Vote passed: ${label}. Executing now.`)}`);
    } catch (err) {
      logPteroError('executeAction passed-say', err);
    }

    if (isPowerAction(action)) {
      try {
        await this.ptero.power('restart');
      } catch (err) {
        logPteroError('executeAction power restart', err);
      }
      return;
    }

    for (const cmd of commandsFor(action)) {
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
          await this.ptero.runCommand(`say ${sanitizeSayText(tps)}`);
        } catch (err) {
          logPteroError('executeAction tps-say', err);
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

/**
 * Pterodactyl `say` argument: strip any control or section-sign sequences so
 * the message stays plain ASCII in-game.
 */
function sanitizeSayText(s: string): string {
  return s.replace(/§./g, '').replace(/[\x00-\x1f\x7f]/g, ' ');
}
