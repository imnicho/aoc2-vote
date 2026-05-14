import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TPS_HEADER_REGEX,
  feedLine,
  makeCaptureState,
} from '../src/spark.js';

test('regex matches a single-line TPS report', () => {
  const line = 'TPS from last 5s, 10s, 1m: 20.0, 20.0, 19.97';
  const m = TPS_HEADER_REGEX.exec(line);
  assert.ok(m);
  assert.equal(m![1]!.trim(), '5s, 10s, 1m');
  assert.equal(m![2]!.trim(), '20.0, 20.0, 19.97');
});

test('feedLine captures single-line output immediately', () => {
  const state = makeCaptureState();
  const out = feedLine(state, 'TPS from last 5s, 10s, 1m: 20.0, 20.0, 19.97');
  assert.equal(out, 'TPS from last 5s, 10s, 1m: 20.0, 20.0, 19.97');
});

test('feedLine handles header-then-values across two lines', () => {
  const state = makeCaptureState();
  assert.equal(
    feedLine(state, 'TPS from last 5s, 10s, 1m, 5m, 15m:'),
    null,
  );
  const out = feedLine(state, '    *20.0, *20.0, *20.0, 19.97, 19.95');
  assert.equal(out, 'TPS from last 5s, 10s, 1m, 5m, 15m: 20.0, 20.0, 20.0, 19.97, 19.95');
});

test('feedLine strips Pterodactyl log prefix and ANSI codes', () => {
  const state = makeCaptureState();
  const line = '[12:34:56 INFO]: [32mTPS from last 5s, 10s, 1m: 20.0, 20.0, 19.97[0m';
  const out = feedLine(state, line);
  assert.equal(out, 'TPS from last 5s, 10s, 1m: 20.0, 20.0, 19.97');
});

test('feedLine returns null for unrelated console output', () => {
  const state = makeCaptureState();
  assert.equal(feedLine(state, 'Saving the game...'), null);
  assert.equal(feedLine(state, ''), null);
});

test('feedLine abandons capture if next line is junk', () => {
  const state = makeCaptureState();
  assert.equal(feedLine(state, 'TPS from last 5s, 10s, 1m:'), null);
  // next non-empty non-numeric line aborts capture
  assert.equal(feedLine(state, 'Saving the game...'), null);
  // and a subsequent values line is NOT captured against the abandoned header
  assert.equal(feedLine(state, '20.0, 20.0, 19.97'), null);
});
