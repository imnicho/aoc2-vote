import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVotePromptCommand,
  buildVotePromptComponents,
  generateShortId,
  IGN_RE,
  SHORT_ID_RE,
} from '../src/tellraw.js';

test('buildVotePromptCommand: targets @a[name=!voter,name=!abstainer]', () => {
  const cmd = buildVotePromptCommand({
    shortId: 'ABCDEF',
    initiator: 'nicho',
    actionLabel: 'clear the weather',
    voted: ['nicho'],
    abstained: ['alice'],
    rosterSize: 3,
    votes: 1,
    needed: 2,
  });
  assert.ok(cmd, 'expected a command string');
  assert.match(cmd!, /^tellraw @a\[name=!nicho,name=!alice\] /);
});

test('buildVotePromptCommand: bare @a when no one has acted yet', () => {
  const cmd = buildVotePromptCommand({
    shortId: 'ABCDEF',
    initiator: 'nicho',
    actionLabel: 'clear the weather',
    voted: [],
    abstained: [],
    rosterSize: 3,
    votes: 0,
    needed: 3,
  });
  assert.ok(cmd);
  assert.match(cmd!, /^tellraw @a /);
});

test('buildVotePromptCommand: returns null when the whole roster has acted', () => {
  const cmd = buildVotePromptCommand({
    shortId: 'ABCDEF',
    initiator: 'nicho',
    actionLabel: 'clear the weather',
    voted: ['nicho', 'alice'],
    abstained: ['bob'],
    rosterSize: 3,
    votes: 2,
    needed: 2,
  });
  assert.equal(cmd, null);
});

test('buildVotePromptCommand: rejects malformed IGNs (selector injection guard)', () => {
  const cmdHostileInitiator = buildVotePromptCommand({
    shortId: 'ABCDEF',
    initiator: 'a; deop @a',
    actionLabel: 'clear the weather',
    voted: [],
    abstained: [],
    rosterSize: 1,
    votes: 0,
    needed: 1,
  });
  assert.equal(cmdHostileInitiator, null);

  const cmdHostileVoter = buildVotePromptCommand({
    shortId: 'ABCDEF',
    initiator: 'nicho',
    actionLabel: 'clear the weather',
    voted: ['alice,name=@e'],
    abstained: [],
    rosterSize: 3,
    votes: 1,
    needed: 2,
  });
  assert.equal(cmdHostileVoter, null);
});

test('buildVotePromptCommand: rejects short ids outside Crockford base32 (I/L/O/U)', () => {
  assert.equal(
    buildVotePromptCommand({
      shortId: 'IIIIII',
      initiator: 'nicho',
      actionLabel: 'clear the weather',
      voted: [],
      abstained: [],
      rosterSize: 1,
      votes: 0,
      needed: 1,
    }),
    null,
  );
  assert.equal(
    buildVotePromptCommand({
      shortId: 'abcdef',
      initiator: 'nicho',
      actionLabel: 'clear the weather',
      voted: [],
      abstained: [],
      rosterSize: 1,
      votes: 0,
      needed: 1,
    }),
    null,
  );
  assert.equal(
    buildVotePromptCommand({
      shortId: 'ABCDE',
      initiator: 'nicho',
      actionLabel: 'clear the weather',
      voted: [],
      abstained: [],
      rosterSize: 1,
      votes: 0,
      needed: 1,
    }),
    null,
  );
});

test('buildVotePromptComponents: click commands carry /vote yes <shortId> and /vote skip <shortId>', () => {
  const parts = buildVotePromptComponents({
    shortId: 'ABCDEF',
    initiator: 'nicho',
    actionLabel: 'clear the weather',
    votes: 1,
    needed: 3,
  }) as Array<Record<string, unknown>>;

  const yes = parts.find((p) => p.text === 'YES') as
    | { clickEvent: { action: string; value: string } }
    | undefined;
  const skip = parts.find((p) => p.text === 'SKIP') as
    | { clickEvent: { action: string; value: string } }
    | undefined;

  assert.ok(yes, 'YES component present');
  assert.ok(skip, 'SKIP component present');
  if (!yes || !skip) return;
  assert.equal(yes.clickEvent.action, 'run_command');
  assert.equal(yes.clickEvent.value, '/vote yes ABCDEF');
  assert.equal(skip.clickEvent.action, 'run_command');
  assert.equal(skip.clickEvent.value, '/vote skip ABCDEF');
});

test('buildVotePromptCommand: tellraw payload uses @a-only selector even with many exclusions', () => {
  const cmd = buildVotePromptCommand({
    shortId: 'ABCDEF',
    initiator: 'nicho',
    actionLabel: 'clear the weather',
    voted: ['nicho', 'alice', 'bob'],
    abstained: ['carol'],
    rosterSize: 5,
    votes: 3,
    needed: 4,
  });
  assert.ok(cmd);
  assert.match(cmd!, /^tellraw @a\[/);
  assert.doesNotMatch(cmd!, /@e\[/);
  // exclusion appears in order of voted then abstained
  assert.match(cmd!, /name=!nicho,name=!alice,name=!bob,name=!carol/);
});

test('generateShortId: returns 6-char Crockford base32', () => {
  for (let i = 0; i < 100; i++) {
    const id = generateShortId();
    assert.equal(id.length, 6);
    assert.match(id, SHORT_ID_RE);
  }
});

test('IGN_RE: accepts valid, rejects punctuation and short names', () => {
  assert.match('nicho', IGN_RE);
  assert.match('Player_99', IGN_RE);
  assert.doesNotMatch('al', IGN_RE);
  assert.doesNotMatch('with space', IGN_RE);
  assert.doesNotMatch('semi;colon', IGN_RE);
  assert.doesNotMatch('comma,bad', IGN_RE);
});
