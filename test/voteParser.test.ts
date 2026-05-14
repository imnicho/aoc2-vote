import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoteParser, stripConsoleNoise } from '../src/voteParser.js';
import type { PollManager } from '../src/poll.js';

interface CastVoteCall { shortId: string; ign: string }
interface AbstainCall { shortId: string; ign: string }

function makeStubPolls(): {
  polls: PollManager;
  castVoteCalls: CastVoteCall[];
  abstainCalls: AbstainCall[];
} {
  const castVoteCalls: CastVoteCall[] = [];
  const abstainCalls: AbstainCall[] = [];
  const stub = {
    castVote: (shortId: string, ign: string) => {
      castVoteCalls.push({ shortId, ign });
      return { ok: true, result: { votes: 1, needed: 2, executed: false } };
    },
    abstain: (shortId: string, ign: string) => {
      abstainCalls.push({ shortId, ign });
      return { ok: true, result: { abstained: 1, needed: 1, executed: false } };
    },
  } as unknown as PollManager;
  return { polls: stub, castVoteCalls, abstainCalls };
}

test('stripConsoleNoise: removes Pterodactyl prefix and ANSI', () => {
  const examples = [
    '[12:34:56] [main/INFO]: * alice votes yes ABCDEF',
    '[12:34:56 INFO]: * alice votes yes ABCDEF',
    '\x1b[32m[12:34:56 INFO]: * alice votes yes ABCDEF\x1b[0m',
    '[12:34:56] [Server thread/INFO] [minecraft/MinecraftServer]: * alice votes yes ABCDEF',
  ];
  for (const ex of examples) {
    assert.equal(stripConsoleNoise(ex), '* alice votes yes ABCDEF');
  }
});

test('parser: positive YES match (plain line)', () => {
  const { polls, castVoteCalls } = makeStubPolls();
  const parser = new VoteParser(polls);
  const out = parser.handleLine('* nicho votes yes ABCDEF');
  assert.equal(out.kind, 'yes');
  assert.equal(out.ign, 'nicho');
  assert.equal(out.shortId, 'ABCDEF');
  assert.deepEqual(castVoteCalls, [{ shortId: 'ABCDEF', ign: 'nicho' }]);
});

test('parser: positive YES match (Pterodactyl noise prefix)', () => {
  const { polls, castVoteCalls } = makeStubPolls();
  const parser = new VoteParser(polls);
  const out = parser.handleLine(
    '[12:34:56] [main/INFO] [minecraft/MinecraftServer]: * alice votes yes XYZWVQ',
  );
  assert.equal(out.kind, 'yes');
  assert.equal(out.ign, 'alice');
  assert.equal(out.shortId, 'XYZWVQ');
  assert.deepEqual(castVoteCalls, [{ shortId: 'XYZWVQ', ign: 'alice' }]);
});

test('parser: positive SKIP match (Pterodactyl noise prefix)', () => {
  const { polls, abstainCalls } = makeStubPolls();
  const parser = new VoteParser(polls);
  const out = parser.handleLine('[12:34:56] [main/INFO]: * bob skips QRSTVW');
  assert.equal(out.kind, 'skip');
  assert.deepEqual(abstainCalls, [{ shortId: 'QRSTVW', ign: 'bob' }]);
});

test('parser: rejects almost-matches', () => {
  const { polls, castVoteCalls, abstainCalls } = makeStubPolls();
  const parser = new VoteParser(polls);
  const noMatches = [
    '* alice votes yes',                   // missing short id
    '* alice votes yes abcdef',            // lowercase
    '* alice votes yes IIIIII',            // I is not Crockford
    '* alice votes yes LLLLLL',
    '* alice votes yes OOOOOO',
    '* alice votes yes UUUUUU',
    '* alice votes yes ABCDE',             // short
    '* alice votes yes ABCDEFG',           // long
    '* alice voted yes ABCDEF',            // wrong tense
    'alice votes yes ABCDEF',              // no leading *
    '<alice> votes yes ABCDEF',            // chat shape, not /me
    '* ab votes yes ABCDEF',               // ign too short
    '* alice extra votes yes ABCDEF',      // extra token between
    '',
  ];
  for (const line of noMatches) {
    const out = parser.handleLine(line);
    assert.equal(out.kind, 'none', `expected no match for: ${JSON.stringify(line)}`);
  }
  assert.equal(castVoteCalls.length, 0);
  assert.equal(abstainCalls.length, 0);
});

test('parser: injection attempts via crafted IGN-like text are rejected', () => {
  const { polls, castVoteCalls } = makeStubPolls();
  const parser = new VoteParser(polls);
  const attempts = [
    '* alice; deop @a votes yes ABCDEF',
    '* "alice" votes yes ABCDEF',
    '* alice]name=@e[ votes yes ABCDEF',
  ];
  for (const line of attempts) {
    parser.handleLine(line);
  }
  assert.equal(castVoteCalls.length, 0);
});

test('parser: enforces a soft per-IGN rate limit', () => {
  const { polls, castVoteCalls } = makeStubPolls();
  const parser = new VoteParser(polls);
  // The limit is 5/min/IGN. The 6th and beyond should be dropped silently
  // (no castVote call) until the window rolls over.
  for (let i = 0; i < 8; i++) {
    parser.handleLine('* nicho votes yes ABCDEF');
  }
  assert.equal(castVoteCalls.length, 5);
});

test('parser: distinct IGNs each get their own rate budget', () => {
  const { polls, castVoteCalls } = makeStubPolls();
  const parser = new VoteParser(polls);
  for (let i = 0; i < 4; i++) parser.handleLine('* alice votes yes ABCDEF');
  for (let i = 0; i < 4; i++) parser.handleLine('* bob votes yes ABCDEF');
  assert.equal(castVoteCalls.length, 8);
});
