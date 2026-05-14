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
    OPERATOR_IGNS: [],
    SESSION_SECRET: null,
    SESSION_TTL_MS: 4 * 60 * 60 * 1000,
    MINT_TTL_MS: 5 * 60 * 1000,
    PUBLIC_BASE_URL: 'http://localhost:4321',
    PTERO_DRY_RUN: false,
    PTERO_MOCK_ROSTER: [],
    SPAWN_COORDS: { x: -1780, y: 117, z: 1187 },
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
  db.insertPoll.run('seed', 'SEED00', 'day', 'alice', 'open', Date.now(), Date.now() + 60_000);

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

test('open() generates a 6-char Crockford short_id exposed on the row', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const res = polls.open('alice', 'weather_clear');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const shortId = res.result.poll.short_id;
  assert.match(shortId, /^[0-9A-HJKMNP-TV-Z]{6}$/);
  db.raw.close();
});

test('castVote(shortId, ign) looks up the open poll and records a vote', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob', 'charlie']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'day');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const shortId = opened.result.poll.short_id;

  const res = polls.castVote(shortId, 'bob');
  assert.equal(res.ok, true);

  // Unknown short id -> poll_not_found
  const miss = polls.castVote('ZZZZZZ', 'charlie');
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.err.kind, 'poll_not_found');
  db.raw.close();
});

test('abstain(shortId, ign) removes the player from the denominator', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob', 'charlie']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'night');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const shortId = opened.result.poll.short_id;
  const pollId = opened.result.poll.id;

  const res = polls.abstain(shortId, 'charlie');
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // 3 online, 1 abstained -> needed should drop to 2.
  assert.equal(res.result.needed, 2);
  // The abstainer is tracked.
  assert.deepEqual(polls.abstainersFor(pollId), ['charlie']);
  // Public snapshot reflects abstained count.
  const pub = polls.publicPolls().find((p) => p.id === pollId);
  assert.ok(pub);
  assert.equal(pub!.abstained, 1);
  assert.equal(pub!.needed, 2);
  db.raw.close();
});

test('pass-with-abstainers: 3 online, 1 abstains, 2 yes -> poll passes', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob', 'charlie']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'save_all');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const shortId = opened.result.poll.short_id;
  const pollId = opened.result.poll.id;

  // Alice's vote was auto-recorded by open(). Charlie abstains.
  const ab = polls.abstain(shortId, 'charlie');
  assert.equal(ab.ok, true);
  if (!ab.ok) return;
  assert.equal(ab.result.executed, false);

  // Bob votes — that should bring online voters (2) >= needed (2).
  const v = polls.vote(pollId, 'bob');
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.result.executed, true);
  db.raw.close();
});

test('abstain() refuses if the player already voted (already_acted)', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'tps');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const shortId = opened.result.poll.short_id;

  const ab = polls.abstain(shortId, 'alice');
  assert.equal(ab.ok, false);
  if (!ab.ok) assert.equal(ab.err.kind, 'already_acted');
  db.raw.close();
});

test('abstain() refuses a non-roster ign as ign_not_online', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['alice', 'bob']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'item_cleanup');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const shortId = opened.result.poll.short_id;

  const ab = polls.abstain(shortId, 'eve');
  assert.equal(ab.ok, false);
  if (!ab.ok) assert.equal(ab.err.kind, 'ign_not_online');
  db.raw.close();
});

test('open() with 3 online players broadcasts a tellraw vote prompt', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['nicho', 'alice', 'bob']);
  const cmds: string[] = [];
  const ptero = {
    runCommand: async (cmd: string) => {
      cmds.push(cmd);
    },
    power: async () => undefined,
    captureTps: async () => null,
  } as unknown as PteroClient;

  const polls = new PollManager(cfg, db, ptero, roster);
  const opened = polls.open('nicho', 'weather_clear');
  assert.equal(opened.ok, true);

  // Allow floating promises to flush.
  await new Promise((r) => setTimeout(r, 20));

  const tellraw = cmds.find((c) => c.startsWith('tellraw '));
  assert.ok(tellraw, `expected a tellraw command, got: ${cmds.join(' | ')}`);
  // Selector excludes the initiator since they auto-voted.
  assert.match(tellraw!, /^tellraw @a\[name=!nicho\] /);
  // Payload references the action label and the YES/SKIP click commands.
  assert.match(tellraw!, /clear the weather/);
  assert.match(tellraw!, /\/me votes yes [0-9A-HJKMNP-TV-Z]{6}/);
  assert.match(tellraw!, /\/me skips [0-9A-HJKMNP-TV-Z]{6}/);
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
