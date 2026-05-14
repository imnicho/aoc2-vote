import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsumedNonceStore,
  signSessionToken,
  verifySessionToken,
} from '../src/sessionToken.js';

const SECRET = 'test-secret-test-secret-test-secret-32+';

test('sign/verify roundtrip — session token', () => {
  const signed = signSessionToken('sess', 'Nicho', true, SECRET, 60_000);
  const v = verifySessionToken(signed.token, 'sess', SECRET);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.value.kind, 'sess');
    assert.equal(v.value.ign, 'nicho');
    assert.equal(v.value.is_operator, true);
    assert.equal(v.value.expires_at, signed.expires_at);
    assert.equal(v.value.nonce, signed.nonce);
  }
});

test('sign/verify roundtrip — mint token (non-operator)', () => {
  const signed = signSessionToken('mint', 'alice', false, SECRET, 60_000);
  const v = verifySessionToken(signed.token, 'mint', SECRET);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.value.kind, 'mint');
    assert.equal(v.value.is_operator, false);
  }
});

test('verify rejects garbage / wrong shape', () => {
  for (const garbage of ['', 'not-base64-!!!', 'AAAA', 'a.b', 'a.b.c.d.e']) {
    const r = verifySessionToken(garbage, 'sess', SECRET);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.err, 'invalid_token');
  }
});

test('verify rejects tampered HMAC', () => {
  const signed = signSessionToken('sess', 'nicho', true, SECRET, 60_000);
  const decoded = Buffer.from(signed.token, 'base64url').toString('utf8');
  const parts = decoded.split('.');
  const sig = parts[5] ?? '';
  const tamperedSig = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
  parts[5] = tamperedSig;
  const tampered = Buffer.from(parts.join('.'), 'utf8').toString('base64url');
  const r = verifySessionToken(tampered, 'sess', SECRET);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.err, 'invalid_token');
});

test('verify rejects wrong secret', () => {
  const signed = signSessionToken('sess', 'nicho', true, SECRET, 60_000);
  const r = verifySessionToken(signed.token, 'sess', 'different-secret-different-secret-32+');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.err, 'invalid_token');
});

test('verify rejects expired token', () => {
  let now = 1_000_000;
  const signed = signSessionToken('sess', 'nicho', false, SECRET, 60_000, () => now);
  now += 60_001;
  const r = verifySessionToken(signed.token, 'sess', SECRET, () => now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.err, 'token_expired');
});

test('verify rejects kind mismatch — mint cannot be replayed as session', () => {
  const signed = signSessionToken('mint', 'nicho', true, SECRET, 60_000);
  const r = verifySessionToken(signed.token, 'sess', SECRET);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.err, 'token_kind_mismatch');
});

test('verify rejects kind mismatch — session cannot be redeemed as mint', () => {
  const signed = signSessionToken('sess', 'nicho', true, SECRET, 60_000);
  const r = verifySessionToken(signed.token, 'mint', SECRET);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.err, 'token_kind_mismatch');
});

test('verify rejects flipped is_operator bit (tampered)', () => {
  const signed = signSessionToken('sess', 'nicho', false, SECRET, 60_000);
  const decoded = Buffer.from(signed.token, 'base64url').toString('utf8');
  const parts = decoded.split('.');
  parts[2] = '1'; // flip is_operator
  const tampered = Buffer.from(parts.join('.'), 'utf8').toString('base64url');
  const r = verifySessionToken(tampered, 'sess', SECRET);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.err, 'invalid_token');
});

test('ConsumedNonceStore: same nonce can only be consumed once', () => {
  const store = new ConsumedNonceStore();
  const exp = Date.now() + 60_000;
  assert.equal(store.consume('abc', exp), true);
  assert.equal(store.consume('abc', exp), false);
  assert.equal(store.consume('def', exp), true);
});

test('ConsumedNonceStore: sweep drops expired entries', () => {
  const store = new ConsumedNonceStore();
  let now = 1_000_000;
  store.consume('abc', now + 1000, () => now);
  store.consume('def', now + 5000, () => now);
  assert.equal(store.size(), 2);
  now += 2000;
  store.sweep(() => now);
  assert.equal(store.size(), 1);
});
