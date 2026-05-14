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

  const tellraws = cmds.filter((c) => c.startsWith('tellraw '));
  // Two tellraws expected: (1) initiator ack to the opener, (2) non-voter prompt.
  assert.equal(tellraws.length, 2, `expected 2 tellraws, got: ${cmds.join(' | ')}`);
  const ack = tellraws.find((t) => t.startsWith('tellraw @a[name=nicho]'));
  const broadcast = tellraws.find((t) => t.startsWith('tellraw @a[name=!nicho]'));
  assert.ok(ack, 'expected initiator ack');
  assert.ok(broadcast, 'expected non-voter broadcast');
  // The broadcast carries the click buttons + action label.
  assert.match(broadcast!, /clear the weather/);
  assert.match(broadcast!, /\/vote yes [0-9A-HJKMNP-TV-Z]{6}/);
  assert.match(broadcast!, /\/vote skip [0-9A-HJKMNP-TV-Z]{6}/);
  // The initiator ack confirms the action.
  assert.match(ack!, /You started a vote/);
  db.raw.close();
});

test('AFK players are excluded from the vote denominator (open + publicPolls)', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['nicho', 'alice', 'bob', 'carol']);
  // bob is AFK — he should not count toward the threshold.
  roster.markAfk('bob');
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const res = polls.open('nicho', 'day');
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const pub = polls.publicPolls().find((p) => p.id === res.result.poll.id);
  assert.ok(pub);
  // Active count is 3 (nicho + alice + carol). Threshold = 3.
  assert.equal(pub!.needed, 3);
  db.raw.close();
});

test('an AFK player who votes is treated as active (denominator updates)', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['nicho', 'alice', 'bob', 'carol']);
  roster.markAfk('bob');
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('nicho', 'night');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  // simulate the AFK tracker reacting to bob's vote-cast emote: he comes
  // back from AFK and is counted in the denominator again.
  roster.markActive('bob');
  const v = polls.vote(opened.result.poll.id, 'bob');
  assert.equal(v.ok, true);
  // active = 4 now, voters = 2 (nicho + bob), threshold = 4 -> not yet passed.
  if (v.ok) assert.equal(v.result.executed, false);
  db.raw.close();
});

test('open() with only the initiator non-AFK executes immediately', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['nicho', 'alice', 'bob']);
  // Everyone but nicho is AFK -> initiator alone among the active.
  roster.markAfk('alice');
  roster.markAfk('bob');
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const res = polls.open('nicho', 'day');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.result.executedImmediately, true);
  db.raw.close();
});

test('open() emits exactly two tellraws (initiator ack + non-voter prompt) and zero say', async () => {
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
  const opened = polls.open('nicho', 'day');
  assert.equal(opened.ok, true);
  await new Promise((r) => setTimeout(r, 20));

  const tellraws = cmds.filter((c) => c.startsWith('tellraw '));
  const says = cmds.filter((c) => c.startsWith('say '));
  assert.equal(tellraws.length, 2, `expected 2 tellraws, got: ${cmds.join(' | ')}`);
  assert.ok(tellraws.some((t) => t.startsWith('tellraw @a[name=nicho]')), 'initiator ack present');
  assert.ok(tellraws.some((t) => t.startsWith('tellraw @a[name=!nicho]')), 'non-voter broadcast present');
  assert.equal(says.length, 0, `expected 0 say, got: ${cmds.join(' | ')}`);
  db.raw.close();
});

test('vote() during an ongoing poll emits a tellraw and no say', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['nicho', 'alice', 'bob', 'carol']);
  const cmds: string[] = [];
  const ptero = {
    runCommand: async (cmd: string) => {
      cmds.push(cmd);
    },
    power: async () => undefined,
    captureTps: async () => null,
  } as unknown as PteroClient;

  const polls = new PollManager(cfg, db, ptero, roster);
  const opened = polls.open('nicho', 'day');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await new Promise((r) => setTimeout(r, 20));

  // Reset captures so we only look at the vote-cast effects.
  cmds.length = 0;

  const res = polls.vote(opened.result.poll.id, 'alice');
  assert.equal(res.ok, true);
  await new Promise((r) => setTimeout(r, 20));

  const tellraws = cmds.filter((c) => c.startsWith('tellraw '));
  const says = cmds.filter((c) => c.startsWith('say '));
  assert.equal(tellraws.length, 1, `expected 1 tellraw, got: ${cmds.join(' | ')}`);
  assert.equal(says.length, 0, `expected 0 say, got: ${cmds.join(' | ')}`);
  db.raw.close();
});

test('a poll that passes emits a `say Vote passed:` (kept) and runs the action', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['nicho', 'alice']);
  const cmds: string[] = [];
  const ptero = {
    runCommand: async (cmd: string) => {
      cmds.push(cmd);
    },
    power: async () => undefined,
    captureTps: async () => null,
  } as unknown as PteroClient;

  const polls = new PollManager(cfg, db, ptero, roster);
  const opened = polls.open('nicho', 'day');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await new Promise((r) => setTimeout(r, 20));

  cmds.length = 0;
  const res = polls.vote(opened.result.poll.id, 'alice');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.result.executed, true);
  await new Promise((r) => setTimeout(r, 30));

  const passedSay = cmds.find((c) => c.startsWith('say ') && c.includes('Vote passed:'));
  assert.ok(passedSay, `expected pass-announcement say, got: ${cmds.join(' | ')}`);
  db.raw.close();
});

test('broadcast selector uses canonical Mojang case for mixed-case voters', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  // Real-world live roster has mixed-case IGNs.
  roster.set(['alice', 'Raedbyr', 'Turanjac', 'cdm144']);
  const cmds: string[] = [];
  const ptero = {
    runCommand: async (cmd: string) => {
      cmds.push(cmd);
    },
    power: async () => undefined,
    captureTps: async () => null,
  } as unknown as PteroClient;

  const polls = new PollManager(cfg, db, ptero, roster);
  const opened = polls.open('alice', 'day');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const shortId = opened.result.poll.short_id;

  // Raedbyr clicks YES — chat parser passes mixed-case to castVote.
  const v = polls.castVote(shortId, 'Raedbyr');
  assert.equal(v.ok, true);
  await new Promise((r) => setTimeout(r, 20));

  const tellraws = cmds.filter((c) => c.startsWith('tellraw '));
  const latest = tellraws[tellraws.length - 1]!;
  // The selector must exclude the actual player profile names. Lowercased
  // exclusions would silently miss and Raedbyr would keep seeing buttons.
  assert.match(latest, /name=!alice/);
  assert.match(latest, /name=!Raedbyr/);
  assert.doesNotMatch(latest, /name=!raedbyr/);
  db.raw.close();
});

test('open() stores initiator_ign in canonical Mojang case for display', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['Raedbyr', 'alice', 'bob']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  // The route layer passes session.ign, which the session-token signer
  // lowercases. Make sure open() recovers the canonical case from the
  // roster so chat doesn't see "raedbyr wants to set day".
  const res = polls.open('raedbyr', 'day');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.result.poll.initiator_ign, 'Raedbyr');
  db.raw.close();
});

test('castVote accepts mixed-case IGN when roster stores canonical case', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  // Roster holds the player's actual Mojang-case IGN.
  roster.set(['Raedbyr', 'alice']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'day');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const shortId = opened.result.poll.short_id;

  // Vote comes in as `Raedbyr` from the /me console line — must be accepted.
  const res = polls.castVote(shortId, 'Raedbyr');
  assert.equal(res.ok, true, `expected vote success, got ${JSON.stringify(res)}`);
  db.raw.close();
});

test('vote() lowercases the ign before insert (DB stores canonical lowercase)', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  // 4-player roster so a single extra vote doesn't pass the poll.
  roster.set(['Raedbyr', 'alice', 'bob', 'carol']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'night');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const pollId = opened.result.poll.id;

  const res = polls.vote(pollId, 'RAEDBYR');
  assert.equal(res.ok, true);

  const voters = polls.publicPolls().find((p) => p.id === pollId)?.voters ?? [];
  // Both initiator and the mixed-case voter normalize to lowercase.
  assert.deepEqual(voters.sort(), ['alice', 'raedbyr']);
  db.raw.close();
});

test('vote() refuses a second cast from the same player even with different case', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  // 4-player roster so the first vote doesn't pass the poll.
  roster.set(['Raedbyr', 'alice', 'bob', 'carol']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'day');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const pollId = opened.result.poll.id;

  const first = polls.vote(pollId, 'Raedbyr');
  assert.equal(first.ok, true);
  const second = polls.vote(pollId, 'raedbyr');
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.err.kind, 'already_voted');
  db.raw.close();
});

test('abstain() accepts mixed-case IGN and stores the abstainer in lowercase', () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['Raedbyr', 'alice', 'bob']);
  const polls = new PollManager(cfg, db, makePteroStub(), roster);

  const opened = polls.open('alice', 'tps');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const shortId = opened.result.poll.short_id;
  const pollId = opened.result.poll.id;

  const ab = polls.abstain(shortId, 'Raedbyr');
  assert.equal(ab.ok, true);
  assert.deepEqual(polls.abstainersFor(pollId), ['raedbyr']);

  // Same player skipping again with any case = already_acted
  const ab2 = polls.abstain(shortId, 'RAEDBYR');
  assert.equal(ab2.ok, false);
  if (!ab2.ok) assert.equal(ab2.err.kind, 'already_acted');
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
