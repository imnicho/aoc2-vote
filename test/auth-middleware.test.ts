import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { bearerAuth } from '../src/auth.js';
import { signSessionToken } from '../src/sessionToken.js';

const SECRET = 'test-secret-test-secret-test-secret-32+';

function buildApp(): Hono {
  const app = new Hono();
  app.post('/probe', bearerAuth(SECRET), (c) => {
    const auth = c.get('auth');
    return c.json({ ign: auth.ign, is_operator: auth.is_operator });
  });
  return app;
}

test('rejects missing Authorization header with 401 unauthorized', async () => {
  const app = buildApp();
  const res = await app.request('/probe', { method: 'POST' });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'unauthorized');
});

test('rejects wrong scheme (Op instead of Bearer)', async () => {
  const app = buildApp();
  const signed = signSessionToken('sess', 'nicho', true, SECRET, 60_000);
  const res = await app.request('/probe', {
    method: 'POST',
    headers: { Authorization: `Op ${signed.token}` },
  });
  assert.equal(res.status, 401);
});

test('rejects malformed token with 401 unauthorized', async () => {
  const app = buildApp();
  const res = await app.request('/probe', {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-token' },
  });
  assert.equal(res.status, 401);
});

test('rejects expired token', async () => {
  const app = buildApp();
  const signed = signSessionToken('sess', 'nicho', true, SECRET, -1);
  const res = await app.request('/probe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${signed.token}` },
  });
  assert.equal(res.status, 401);
});

test('rejects mint token presented as session', async () => {
  const app = buildApp();
  const signed = signSessionToken('mint', 'nicho', true, SECRET, 60_000);
  const res = await app.request('/probe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${signed.token}` },
  });
  assert.equal(res.status, 401);
});

test('accepts a valid session token and attaches auth context', async () => {
  const app = buildApp();
  const signed = signSessionToken('sess', 'Nicho', true, SECRET, 60_000);
  const res = await app.request('/probe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${signed.token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ign: string; is_operator: boolean };
  assert.equal(body.ign, 'nicho');
  assert.equal(body.is_operator, true);
});

test('rejects missing secret outright', async () => {
  const app = new Hono();
  app.post('/probe', bearerAuth(null), (c) => c.json({ ok: true }));
  const signed = signSessionToken('sess', 'nicho', false, SECRET, 60_000);
  const res = await app.request('/probe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${signed.token}` },
  });
  assert.equal(res.status, 401);
});
