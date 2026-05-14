import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  ACTION_LABELS,
  actionLabel,
  commandsFor,
  isAction,
  isPowerAction,
} from '../src/actions.js';

test('ACTIONS enum is the contract-defined set in order', () => {
  assert.deepEqual(
    [...ACTIONS],
    [
      'weather_clear',
      'item_cleanup',
      'day',
      'night',
      'tps',
      'save_all',
      'gather_at_spawn',
      'restart',
    ],
  );
});

test('isAction narrows strings only for known actions', () => {
  assert.equal(isAction('day'), true);
  assert.equal(isAction('weather_clear'), true);
  assert.equal(isAction('gather_at_spawn'), true);
  assert.equal(isAction('teleport_everyone_to_void'), false);
  assert.equal(isAction(123), false);
  assert.equal(isAction(null), false);
  assert.equal(isAction(undefined), false);
  assert.equal(isAction({}), false);
});

test('labels match the contract exactly', () => {
  assert.equal(actionLabel('weather_clear'), 'clear the weather');
  assert.equal(actionLabel('item_cleanup'), 'clean up dropped items');
  assert.equal(actionLabel('day'), 'set the time to day');
  assert.equal(actionLabel('night'), 'set the time to night');
  assert.equal(actionLabel('tps'), 'run a TPS report');
  assert.equal(actionLabel('save_all'), 'save the world');
  assert.equal(actionLabel('gather_at_spawn'), 'bring everyone to spawn');
  assert.equal(actionLabel('restart'), 'restart the server');
});

test('every action has a non-empty label', () => {
  for (const a of ACTIONS) {
    assert.ok(ACTION_LABELS[a].length > 0, `label missing for ${a}`);
  }
});

test('commandsFor returns the right console commands', () => {
  assert.deepEqual(commandsFor('weather_clear'), ['weather clear']);
  assert.deepEqual(commandsFor('item_cleanup'), ['kill @e[type=item]']);
  assert.deepEqual(commandsFor('day'), ['time set day']);
  assert.deepEqual(commandsFor('night'), ['time set night']);
  assert.deepEqual(commandsFor('tps'), ['spark tps']);
  assert.deepEqual(commandsFor('save_all'), ['save-all']);
  assert.deepEqual(commandsFor('restart'), []);
});

test('commandsFor("gather_at_spawn") returns a single @a tp command when coords are present', () => {
  assert.deepEqual(
    commandsFor('gather_at_spawn', { spawn: { x: 0, y: 100, z: 0 } }),
    ['tp @a 0 100 0'],
  );
  assert.deepEqual(
    commandsFor('gather_at_spawn', { spawn: { x: -42, y: 64, z: 1337 } }),
    ['tp @a -42 64 1337'],
  );
});

test('commandsFor("gather_at_spawn") returns empty array when no spawn coords', () => {
  assert.deepEqual(commandsFor('gather_at_spawn'), []);
  assert.deepEqual(commandsFor('gather_at_spawn', {}), []);
  assert.deepEqual(commandsFor('gather_at_spawn', { spawn: null }), []);
});

test('gather_at_spawn never emits any selector other than @a', () => {
  // Whatever the coords, the only selector ever embedded in the command is @a.
  for (const coords of [
    { x: 0, y: 0, z: 0 },
    { x: -1, y: 1, z: -1 },
    { x: 1000, y: 256, z: -1000 },
  ]) {
    const cmds = commandsFor('gather_at_spawn', { spawn: coords });
    assert.equal(cmds.length, 1);
    const cmd = cmds[0] ?? '';
    assert.match(cmd, /^tp @a -?\d+ -?\d+ -?\d+$/);
    assert.ok(!cmd.includes('@e'), 'must not include @e');
    assert.ok(!cmd.includes('@p'), 'must not include @p');
    assert.ok(!cmd.includes('@r'), 'must not include @r');
    assert.ok(!cmd.includes('@s'), 'must not include @s');
  }
});

test('isPowerAction only for restart', () => {
  for (const a of ACTIONS) {
    assert.equal(isPowerAction(a), a === 'restart');
  }
});
