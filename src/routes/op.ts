import { Hono } from 'hono';
import type { Config } from '../config.js';
import { bearerAuth } from '../auth.js';
import { clientIp } from '../clientIp.js';
import type { OperatorExec } from '../operatorExec.js';
import type { RateLimiter } from '../rateLimit.js';

interface ExecuteBody {
  action?: unknown;
}

export interface OpRouteDeps {
  cfg: Config;
  ops: OperatorExec;
  executeLimiter: RateLimiter;
}

export function opRoute(deps: OpRouteDeps): Hono {
  const { cfg, ops, executeLimiter } = deps;
  const app = new Hono();

  app.post('/api/op/execute', bearerAuth(cfg.SESSION_SECRET), async (c) => {
    const ip = clientIp(c);
    if (!executeLimiter.take(ip)) return c.json({ error: 'rate_limited' }, 429);

    const auth = c.get('auth');
    if (!auth.is_operator) return c.json({ error: 'unauthorized' }, 403);

    let body: ExecuteBody;
    try {
      body = (await c.req.json()) as ExecuteBody;
    } catch {
      return c.json({ error: 'invalid_action' }, 400);
    }

    const res = await ops.execute(auth.ign, body.action);
    if (!res.ok) {
      switch (res.err.kind) {
        case 'invalid_action':
          return c.json({ error: 'invalid_action' }, 400);
        case 'action_on_cooldown':
          return c.json({ error: 'action_on_cooldown', until: res.err.until }, 409);
      }
    }
    return c.json({ ok: true, executed: true });
  });

  return app;
}
