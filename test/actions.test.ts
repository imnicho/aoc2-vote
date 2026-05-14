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
    ['weather_clear', 'item_cleanup', 'day', 'night', 'tps', 'save_all', 'restart'],
  );
});

test('isAction narrows strings only for known actions', () => {
  assert.equal(isAction('day'), true);
  assert.equal(isAction('weather_clear'), true);
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

test('isPowerAction only for restart', () => {
  for (const a of ACTIONS) {
    assert.equal(isPowerAction(a), a === 'restart');
  }
});
