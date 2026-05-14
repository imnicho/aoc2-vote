import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IgnBinding } from '../src/ignBinding.js';

test('first-touch is always ok and records on demand', () => {
  const b = new IgnBinding(10_000);
  assert.equal(b.check('alice', '1.1.1.1').kind, 'ok');
  assert.equal(b.size(), 0); // check() must not mutate
  b.record('alice', '1.1.1.1');
  assert.equal(b.size(), 1);
});

test('same IP keeps returning ok and refreshes the expiry', () => {
  let now = 1000;
  const b = new IgnBinding(10_000, () => now);
  b.record('alice', '1.1.1.1');
  assert.equal(b.check('alice', '1.1.1.1').kind, 'ok');

  // halfway through TTL — still ok, and a record() pushes the window out
  now = 6000;
  assert.equal(b.check('alice', '1.1.1.1').kind, 'ok');
  b.record('alice', '1.1.1.1');

  now = 15000; // past the original TTL but inside the refreshed one
  assert.equal(b.check('alice', '1.1.1.1').kind, 'ok');
});

test('different IP while bound is a mismatch', () => {
  const b = new IgnBinding(10_000);
  b.record('alice', '1.1.1.1');
  const res = b.check('alice', '2.2.2.2');
  assert.equal(res.kind, 'mismatch');
});

test('IGN match is case-insensitive', () => {
  const b = new IgnBinding(10_000);
  b.record('Alice', '1.1.1.1');
  assert.equal(b.check('alice', '1.1.1.1').kind, 'ok');
  assert.equal(b.check('ALICE', '2.2.2.2').kind, 'mismatch');
});

test('TTL eviction lets a fresh IP take the binding', () => {
  let now = 0;
  const b = new IgnBinding(10_000, () => now);
  b.record('alice', '1.1.1.1');

  now = 10_001;
  const res = b.check('alice', '2.2.2.2');
  assert.equal(res.kind, 'ok'); // expired entry was evicted
  assert.equal(b.size(), 0);
  b.record('alice', '2.2.2.2');
  // now 2.2.2.2 owns the binding
  now = 10_500;
  assert.equal(b.check('alice', '1.1.1.1').kind, 'mismatch');
});

test('sweep purges expired entries', () => {
  let now = 0;
  const b = new IgnBinding(10_000, () => now);
  b.record('alice', '1.1.1.1');
  b.record('bob', '2.2.2.2');
  now = 10_001;
  b.sweep();
  assert.equal(b.size(), 0);
});
