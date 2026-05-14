import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'hono';
import { clientIp } from '../src/clientIp.js';

interface FakeOpts {
  xff?: string;
  realIp?: string;
  remote?: string;
}

function fakeContext(opts: FakeOpts): Context {
  const headers = new Map<string, string>();
  if (opts.xff !== undefined) headers.set('x-forwarded-for', opts.xff);
  if (opts.realIp !== undefined) headers.set('x-real-ip', opts.realIp);
  const env: { incoming?: { socket?: { remoteAddress?: string } } } = {};
  if (opts.remote !== undefined) {
    env.incoming = { socket: { remoteAddress: opts.remote } };
  }
  return {
    req: {
      header: (name: string) => headers.get(name.toLowerCase()),
    },
    env,
  } as unknown as Context;
}

test('returns X-Real-IP when present', () => {
  const c = fakeContext({ realIp: '203.0.113.5', xff: '1.1.1.1, 2.2.2.2' });
  assert.equal(clientIp(c), '203.0.113.5');
});

test('reads the rightmost X-Forwarded-For entry when X-Real-IP is absent', () => {
  // Traefik appends the real client IP to the right; the leftmost values
  // could have been forged by the caller.
  const c = fakeContext({ xff: '99.99.99.99, 198.51.100.7' });
  assert.equal(clientIp(c), '198.51.100.7');
});

test('handles a single-entry X-Forwarded-For', () => {
  const c = fakeContext({ xff: '198.51.100.7' });
  assert.equal(clientIp(c), '198.51.100.7');
});

test('strips surrounding whitespace in X-Forwarded-For', () => {
  const c = fakeContext({ xff: '99.99.99.99 ,   198.51.100.7   ' });
  assert.equal(clientIp(c), '198.51.100.7');
});

test('falls back to the socket peer address when no proxy headers present', () => {
  const c = fakeContext({ remote: '127.0.0.1' });
  assert.equal(clientIp(c), '127.0.0.1');
});

test('returns "unknown" when nothing is available', () => {
  const c = fakeContext({});
  assert.equal(clientIp(c), 'unknown');
});

test('does not mistake an empty X-Real-IP for the actual client', () => {
  const c = fakeContext({ realIp: '   ', xff: '198.51.100.7' });
  assert.equal(clientIp(c), '198.51.100.7');
});
