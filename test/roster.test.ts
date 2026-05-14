import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Roster, parseJoinLine, parseLeaveLine, parseListLine } from '../src/roster.js';

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

test('Roster.has handles mixed-case input against canonical-case storage', () => {
  const r = new Roster();
  r.addPlayer('Raedbyr');
  assert.equal(r.has('Raedbyr'), true);
  assert.equal(r.has('raedbyr'), true);
  assert.equal(r.has('RAEDBYR'), true);
  // lower-case stored, mixed-case query still matches
  const r2 = new Roster();
  r2.addPlayer('cdm144');
  assert.equal(r2.has('CDM144'), true);
});

test('Roster.size reflects the current roster', () => {
  const r = new Roster();
  assert.equal(r.size(), 0);
  r.set(['a', 'b', 'c']);
  assert.equal(r.size(), 3);
  r.set([]);
  assert.equal(r.size(), 0);
});

test('parseJoinLine matches "X joined the game" with log prefixes', () => {
  assert.equal(parseJoinLine('[12:34:56 INFO]: nicho joined the game'), 'nicho');
  assert.equal(parseJoinLine('[Server thread/INFO]: alice joined the game'), 'alice');
  assert.equal(parseJoinLine('* nicho votes yes ABCDEF'), null);
  assert.equal(parseJoinLine('nicho left the game'), null);
  // Too-short IGN
  assert.equal(parseJoinLine('xy joined the game'), null);
});

test('parseLeaveLine matches "X left the game"', () => {
  assert.equal(parseLeaveLine('[12:34:56 INFO]: nicho left the game'), 'nicho');
  assert.equal(parseLeaveLine('nicho joined the game'), null);
});

test('Roster.markAfk / markActive / activeCount', () => {
  const r = new Roster();
  r.set(['nicho', 'alice', 'bob']);
  assert.equal(r.activeCount(), 3);

  assert.equal(r.markAfk('alice'), true);
  assert.equal(r.isAfk('alice'), true);
  assert.equal(r.activeCount(), 2);
  // case-insensitive
  assert.equal(r.isAfk('ALICE'), true);

  // double-mark is a no-op
  assert.equal(r.markAfk('alice'), false);

  // mark active
  assert.equal(r.markActive('Alice'), true);
  assert.equal(r.isAfk('alice'), false);
  assert.equal(r.activeCount(), 3);
});

test('Roster.set prunes AFK entries for departed players', () => {
  const r = new Roster();
  r.set(['nicho', 'alice', 'bob']);
  r.markAfk('alice');
  r.markAfk('bob');
  assert.deepEqual(r.afkList().sort(), ['alice', 'bob']);
  // alice leaves
  r.set(['nicho', 'bob']);
  assert.deepEqual(r.afkList(), ['bob']);
});

test('Roster.markAfk refuses an IGN not in the roster', () => {
  const r = new Roster();
  r.set(['nicho']);
  assert.equal(r.markAfk('eve'), false);
  assert.equal(r.isAfk('eve'), false);
});

test('Roster.addPlayer / removePlayer fire join/leave listeners', () => {
  const r = new Roster();
  const joined: string[] = [];
  const left: string[] = [];
  r.onPlayerJoin((ign) => joined.push(ign));
  r.onPlayerLeave((ign) => left.push(ign));
  assert.equal(r.addPlayer('nicho'), true);
  assert.equal(r.addPlayer('nicho'), false); // duplicate
  assert.equal(r.removePlayer('nicho'), true);
  assert.equal(r.removePlayer('nicho'), false); // not present
  assert.deepEqual(joined, ['nicho']);
  assert.deepEqual(left, ['nicho']);
});
