import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { PollManager } from '../src/poll.js';
import { Roster } from '../src/roster.js';
import type { PteroClient } from '../src/ptero.js';

function makeCfg(): Config {
  return {
    PTERO_BASE: 'http://localhost',
    PTERO_SERVER_ID: 'srv-test',
    PTERO_TOKEN: 'ptlc_SECRET_BEARER_DO_NOT_LEAK',
    ALLOWED_ORIGIN: 'http://localhost',
    PORT: 0,
    DB_PATH: ':memory:',
    POLL_TTL_MS: 300_000,
    COOLDOWN_MS: 600_000,
    ROSTER_REFRESH_MS: 5_000,
  };
}

function makeDb(): DB {
  const dir = mkdtempSync(join(tmpdir(), 'aoc2-vote-test-'));
  return openDb(join(dir, 'test.db'));
}

function makePteroStub(): PteroClient {
  return {
    runCommand: async () => undefined,
    power: async () => undefined,
    captureTps: async () => null,
  } as unknown as PteroClient;
}

test('open() rejects a concurrent duplicate with poll_already_open (transactional)', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob', 'charlie']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const first = polls.open('alice', 'day');
  assert.equal(first.ok, true);
  const second = polls.open('bob', 'day');
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.err.kind, 'poll_already_open');
  db.raw.close();
});

test('open() surfaces SQLITE_CONSTRAINT_UNIQUE as poll_already_open if the unique-index races', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  // Pre-seed an open poll for `day` so the inner transaction hits the
  // unique-index path even though the in-tx pre-check would also catch it.
  db.insertPoll.run('seed', 'day', 'alice', 'open', Date.now(), Date.now() + 60_000);

  const res = polls.open('bob', 'day');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.err.kind, 'poll_already_open');
  db.raw.close();
});

test('vote() rejects double-vote with already_voted (transactional)', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob', 'charlie']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'day');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const pollId = opened.result.poll.id;

  // bob votes, then bob tries to vote again
  const v1 = polls.vote(pollId, 'bob');
  assert.equal(v1.ok, true);
  const v2 = polls.vote(pollId, 'bob');
  assert.equal(v2.ok, false);
  if (!v2.ok) assert.equal(v2.err.kind, 'already_voted');
  db.raw.close();
});

test('vote() surfaces vote PK collision as already_voted', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'night');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const pollId = opened.result.poll.id;

  // Manually insert a vote so the transaction body hits the PK collision path.
  db.insertVote.run(pollId, 'bob', Date.now());
  const v = polls.vote(pollId, 'bob');
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.err.kind, 'already_voted');
  db.raw.close();
});

test('ptero failure log never echoes the bearer token', async () => {
  // Spy on console.error
  const captured: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  try {
    const cfg = makeCfg();
    const db = makeDb();
    const roster = new Roster();
    roster.set(['alice']);
    // Single-online-player path executes immediately, hitting executeAction
    // which forwards to runCommand. Make runCommand reject with a message
    // that LOOKS like it could contain the token; the logger must strip it.
    const ptero = {
      runCommand: async () => {
        throw new Error('Pterodactyl command failed: 401 {"errors":[{"detail":"Unauthenticated."}]} BEARER_TOKEN_LEAK');
      },
      power: async () => undefined,
      captureTps: async () => null,
    } as unknown as PteroClient;

    const polls = new PollManager(cfg, db, ptero, roster);
    const res = polls.open('alice', 'save_all');
    assert.equal(res.ok, true);

    // Give the floating promise a moment to settle.
    await new Promise((r) => setTimeout(r, 50));

    // Some message should have been logged via console.error
    assert.ok(captured.length > 0, 'expected at least one console.error');
    for (const line of captured) {
      assert.ok(!line.includes('BEARER_TOKEN_LEAK'), `leaked response body: ${line}`);
      assert.ok(!line.includes(cfg.PTERO_TOKEN), `leaked bearer token: ${line}`);
      assert.ok(!line.toLowerCase().includes('unauthenticated'), `leaked response detail: ${line}`);
    }
    db.raw.close();
  } finally {
    console.error = orig;
  }
});
