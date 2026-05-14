import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AfkTracker } from '../src/afkTracker.js';
import { Roster } from '../src/roster.js';

test('AFK on-pattern marks player AFK; off-pattern clears it', () => {
  const r = new Roster();
  r.set(['nicho', 'alice']);
  const t = new AfkTracker(r, { idleMs: 60_000, sweepMs: 60_000 });

  t.handleLine('nicho is now AFK');
  assert.equal(r.isAfk('nicho'), true);
  assert.equal(r.activeCount(), 1);

  t.handleLine('nicho is no longer AFK');
  assert.equal(r.isAfk('nicho'), false);
  assert.equal(r.activeCount(), 2);
});

test('AFK patterns tolerate FTB-style style/color noise prefix', () => {
  const r = new Roster();
  r.set(['nicho']);
  const t = new AfkTracker(r, { idleMs: 60_000, sweepMs: 60_000 });

  // FTB Essentials prepends a style/colour byte and sometimes a leading
  // section sign or formatting marker that `stripConsoleNoise` won't catch.
  t.handleLine('§7nicho is now AFK§r');
  assert.equal(r.isAfk('nicho'), true);
  t.handleLine('§7nicho is no longer AFK§r');
  assert.equal(r.isAfk('nicho'), false);
});

test('chat line resets AFK and updates activity timestamp', () => {
  const r = new Roster();
  r.set(['nicho']);
  const t = new AfkTracker(r, { idleMs: 60_000, sweepMs: 60_000 });

  r.markAfk('nicho');
  assert.equal(r.isAfk('nicho'), true);
  t.handleLine('<nicho> hello world');
  assert.equal(r.isAfk('nicho'), false);
});

test('/me emote line counts as activity', () => {
  const r = new Roster();
  r.set(['nicho']);
  const t = new AfkTracker(r, { idleMs: 60_000, sweepMs: 60_000 });

  r.markAfk('nicho');
  t.handleLine('* nicho votes yes ABCDEF');
  assert.equal(r.isAfk('nicho'), false);
});

test('case-insensitive recognition (mixed-case IGN in FTB line)', () => {
  const r = new Roster();
  r.set(['Raedbyr']);
  const t = new AfkTracker(r, { idleMs: 60_000, sweepMs: 60_000 });

  t.handleLine('Raedbyr is now AFK');
  assert.equal(r.isAfk('Raedbyr'), true);
  assert.equal(r.isAfk('raedbyr'), true);
});

test('removePlayer clears AFK flag', () => {
  const r = new Roster();
  r.addPlayer('nicho');
  r.markAfk('nicho');
  assert.equal(r.isAfk('nicho'), true);
  r.removePlayer('nicho');
  assert.equal(r.isAfk('nicho'), false);
  assert.equal(r.afkList().length, 0);
});

test('recordActivity is a no-op for IGNs not in the roster', () => {
  const r = new Roster();
  const t = new AfkTracker(r, { idleMs: 60_000, sweepMs: 60_000 });
  t.recordActivity('eve');
  // No AFK state created, no roster change.
  assert.equal(r.size(), 0);
  assert.equal(r.afkList().length, 0);
});
