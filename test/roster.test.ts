import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Roster, parseListLine } from '../src/roster.js';

test('parses a typical vanilla list response', () => {
  const r = parseListLine('There are 3 of a max of 20 players online: alice, bob, charlie');
  assert.deepEqual(r, { online: 3, max: 20, players: ['alice', 'bob', 'charlie'] });
});

test('parses zero-player response', () => {
  const r = parseListLine('There are 0 of a max of 20 players online: ');
  assert.deepEqual(r, { online: 0, max: 20, players: [] });
});

test('handles log prefix from Pterodactyl console', () => {
  const r = parseListLine('[12:34:56 INFO]: There are 1 of a max of 20 players online: nicho');
  assert.deepEqual(r, { online: 1, max: 20, players: ['nicho'] });
});

test('returns null for unrelated console lines', () => {
  assert.equal(parseListLine('Saving the game (this may take a moment!)'), null);
  assert.equal(parseListLine('random nonsense'), null);
  assert.equal(parseListLine(''), null);
});

test('trims whitespace and filters empty entries', () => {
  const r = parseListLine('There are 2 of a max of 5 players online:   alice,   bob  ,  ');
  assert.deepEqual(r?.players, ['alice', 'bob']);
});

test('Roster.set emits change only on a different sorted set', () => {
  const r = new Roster();
  let changes = 0;
  r.onChange(() => changes++);
  assert.equal(r.set(['bob', 'alice']), true);
  assert.equal(changes, 1);
  assert.deepEqual(r.get(), ['alice', 'bob']);
  // same set in different order — no change
  assert.equal(r.set(['alice', 'bob']), false);
  assert.equal(changes, 1);
  // membership check is case-insensitive
  assert.equal(r.has('ALICE'), true);
  assert.equal(r.has('charlie'), false);
});

test('Roster.size reflects the current roster', () => {
  const r = new Roster();
  assert.equal(r.size(), 0);
  r.set(['a', 'b', 'c']);
  assert.equal(r.size(), 3);
  r.set([]);
  assert.equal(r.size(), 0);
});
