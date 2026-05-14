import { Hono } from 'hono';
import { clientIp } from '../clientIp.js';
import type { Config } from '../config.js';
import type { RateLimiter } from '../rateLimit.js';
import {
  ConsumedNonceStore,
  signSessionToken,
  verifySessionToken,
} from '../sessionToken.js';

interface RedeemBody {
  token?: unknown;
}

export interface AuthRouteDeps {
  cfg: Config;
  limiter: RateLimiter;
  consumed: ConsumedNonceStore;
}

export function authRoute(deps: AuthRouteDeps): Hono {
  const { cfg, limiter, consumed } = deps;
  const app = new Hono();

  app.post('/api/auth/redeem', async (c) => {
    const ip = clientIp(c);
    if (!limiter.take(ip)) return c.json({ error: 'rate_limited' }, 429);

    if (!cfg.SESSION_SECRET) return c.json({ error: 'invalid_token' }, 400);

    let body: RedeemBody;
    try {
      body = (await c.req.json()) as RedeemBody;
    } catch {
      return c.json({ error: 'invalid_token' }, 400);
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return c.json({ error: 'invalid_token' }, 400);

    const verified = verifySessionToken(token, 'mint', cfg.SESSION_SECRET);
    if (!verified.ok) {
      if (verified.err === 'token_expired') {
        return c.json({ error: 'token_expired' }, 400);
      }
      return c.json({ error: 'invalid_token' }, 400);
    }

    const fresh = consumed.consume(verified.value.nonce, verified.value.expires_at);
    if (!fresh) return c.json({ error: 'token_used' }, 400);

    const session = signSessionToken(
      'sess',
      verified.value.ign,
      verified.value.is_operator,
      cfg.SESSION_SECRET,
      cfg.SESSION_TTL_MS,
    );

    return c.json({
      session_token: session.token,
      expires_at: session.expires_at,
      ign: verified.value.ign,
      is_operator: verified.value.is_operator,
    });
  });

  return app;
}
