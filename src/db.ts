import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Action } from './actions.js';

export interface PollRow {
  id: string;
  short_id: string;
  action: Action;
  initiator_ign: string;
  status: 'open' | 'passed' | 'expired' | 'cancelled';
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}

export interface VoteRow {
  poll_id: string;
  ign: string;
  voted_at: number;
}

export interface CooldownRow {
  action: Action;
  until: number;
}

export interface DB {
  raw: Database.Database;
  insertPoll: Database.Statement<[string, string, string, string, string, number, number]>;
  getPoll: Database.Statement<[string]>;
  getOpenPollByAction: Database.Statement<[string]>;
  getOpenPollByShortId: Database.Statement<[string]>;
  shortIdExists: Database.Statement<[string]>;
  listOpenPolls: Database.Statement<[]>;
  expireStalePolls: Database.Statement<[number, number]>;
  setPollStatus: Database.Statement<[string, number, string]>;
  insertVote: Database.Statement<[string, string, number]>;
  getVotes: Database.Statement<[string]>;
  hasVoted: Database.Statement<[string, string]>;
  upsertCooldown: Database.Statement<[string, number]>;
  deleteExpiredCooldowns: Database.Statement<[number]>;
  listCooldowns: Database.Statement<[]>;
}

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      short_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      initiator_ign TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','passed','expired','cancelled')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS polls_one_open_per_action
      ON polls(action) WHERE status = 'open';
    CREATE UNIQUE INDEX IF NOT EXISTS polls_one_open_per_short_id
      ON polls(short_id) WHERE status = 'open' AND short_id != '';

    CREATE TABLE IF NOT EXISTS votes (
      poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      ign TEXT NOT NULL,
      voted_at INTEGER NOT NULL,
      PRIMARY KEY (poll_id, ign)
    );

    CREATE TABLE IF NOT EXISTS cooldowns (
      action TEXT PRIMARY KEY,
      until INTEGER NOT NULL
    );
  `);

  // Drop the legacy operators table from before the bearer-session redesign.
  // Operators are now stateless — membership is checked against OPERATOR_IGNS
  // at session-mint time, and the resulting bearer carries the flag.
  raw.exec(`DROP TABLE IF EXISTS operators`);

  // Migration: add short_id to existing polls tables that pre-date the column.
  const cols = raw.prepare(`PRAGMA table_info(polls)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'short_id')) {
    raw.exec(`ALTER TABLE polls ADD COLUMN short_id TEXT NOT NULL DEFAULT ''`);
    raw.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS polls_one_open_per_short_id
       ON polls(short_id) WHERE status = 'open' AND short_id != ''`,
    );
  }

  return {
    raw,
    insertPoll: raw.prepare(
      `INSERT INTO polls (id, short_id, action, initiator_ign, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    getPoll: raw.prepare(`SELECT * FROM polls WHERE id = ?`),
    getOpenPollByAction: raw.prepare(
      `SELECT * FROM polls WHERE action = ? AND status = 'open'`,
    ),
    getOpenPollByShortId: raw.prepare(
      `SELECT * FROM polls WHERE short_id = ? AND status = 'open'`,
    ),
    shortIdExists: raw.prepare(
      `SELECT 1 FROM polls WHERE short_id = ? AND status = 'open'`,
    ),
    listOpenPolls: raw.prepare(`SELECT * FROM polls WHERE status = 'open'`),
    expireStalePolls: raw.prepare(
      `UPDATE polls SET status = 'expired', resolved_at = ?
       WHERE status = 'open' AND expires_at <= ?`,
    ),
    setPollStatus: raw.prepare(
      `UPDATE polls SET status = ?, resolved_at = ? WHERE id = ?`,
    ),
    insertVote: raw.prepare(
      `INSERT INTO votes (poll_id, ign, voted_at) VALUES (?, ?, ?)`,
    ),
    getVotes: raw.prepare(
      `SELECT ign FROM votes WHERE poll_id = ? ORDER BY voted_at ASC`,
    ),
    hasVoted: raw.prepare(
      `SELECT 1 FROM votes WHERE poll_id = ? AND lower(ign) = lower(?)`,
    ),
    upsertCooldown: raw.prepare(
      `INSERT INTO cooldowns (action, until) VALUES (?, ?)
       ON CONFLICT(action) DO UPDATE SET until = excluded.until`,
    ),
    deleteExpiredCooldowns: raw.prepare(`DELETE FROM cooldowns WHERE until <= ?`),
    listCooldowns: raw.prepare(`SELECT action, until FROM cooldowns`),
  };
}
