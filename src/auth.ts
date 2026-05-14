import type { Context, MiddlewareHandler } from 'hono';
import { verifySessionToken } from './sessionToken.js';

export interface AuthContext {
  ign: string;
  is_operator: boolean;
  expires_at: number;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * Reads `Authorization: Bearer <token>` and attaches the verified session
 * to `c.set('auth', ...)`. Rejects with 401 `{"error":"unauthorized"}` for
 * any failure mode (missing header, bad shape, tampered, expired, mint-kind
 * presented as session).
 */
export function bearerAuth(secret: string | null): MiddlewareHandler {
  return async (c, next) => {
    if (!secret) return unauthorized(c);
    const header = c.req.header('authorization') || c.req.header('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return unauthorized(c);
    const token = (m[1] ?? '').trim();
    if (!token) return unauthorized(c);
    const verified = verifySessionToken(token, 'sess', secret);
    if (!verified.ok) return unauthorized(c);
    c.set('auth', {
      ign: verified.value.ign,
      is_operator: verified.value.is_operator,
      expires_at: verified.value.expires_at,
    });
    await next();
    return undefined;
  };
}

function unauthorized(c: Context): Response {
  return c.json({ error: 'unauthorized' }, 401);
}
