import { Hono } from 'hono';
import { clientIp } from '../clientIp.js';
import type { RateLimiter } from '../rateLimit.js';
import type { Roster } from '../roster.js';

export function checkIgnRoute(roster: Roster, limiter: RateLimiter): Hono {
  const app = new Hono();
  app.get('/api/check-ign', (c) => {
    const ip = clientIp(c);
    if (!limiter.take(ip)) return c.json({ error: 'rate_limited' }, 429);
    const ign = c.req.query('ign');
    if (!ign || ign.trim().length === 0 || ign.length > 32 || !/^[A-Za-z0-9_]+$/.test(ign)) {
      return c.json({ error: 'missing_ign' }, 400);
    }
    return c.json({ online: roster.has(ign) });
  });
  return app;
}
